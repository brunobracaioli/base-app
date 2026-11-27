# ADR 0004 — Supabase Auth e verificação do JWT por JWKS

- **Status:** accepted — decisões locais W6 registradas em 2026-11-26; validação hospedada pendente
- **Data:** 2026-11-24; atualizado em 2026-11-26

## Contexto

O base-app oferece login só por e-mail: código (OTP) e e-mail + senha, com confirmação de
e-mail e redefinição de senha. Implementar isso à mão (hash de senha, códigos de reset em
coluna, emissão de JWT) é código sensível que o template não deve ensinar a repetir.

Os e-mails de login precisam sair em três idiomas (pt-BR, en, es), com entrega confiável.

## Decisão

- **Supabase Auth** é o provedor de identidade: credenciais, sessões, refresh com rotação e
  e-mails de login. Configurado como código em `supabase/config.toml`.
- **Só login por e-mail** (`email_otp` e `email_password`). Sem login social e sem modo
  visitante no base-app.
- O projeto usa **chaves de assinatura assimétricas**. A API verifica o access token
  localmente com `jose` contra o JWKS público, com allowlist de algoritmo (`ES256`, `RS256`),
  e valida `iss`, `aud = authenticated`, `exp`, `iat`, `sub` e `role`. `alg: none` é rejeitado.
  JWKS em cache por 10 min; com cache vazio e JWKS fora, a API responde 503
  (`auth.unavailable`) e nunca aceita sem verificar.
- A API **não emite tokens** e não tem tabela de credenciais.
- O app guarda a sessão cifrada: chave AES no Keychain/Keystore (SecureStore) e blob cifrado no
  AsyncStorage.
- Access token de 15 min. Revogação é o fim da renovação; o access token já emitido vale até
  expirar. Ações sensíveis exigem login recente (≤ 5 min, pelo `amr` do JWT).
- O token do usuário vai ao Postgres do próprio Supabase só como claims mínimas dentro da
  transação (ADR 0005), nunca a terceiros.
- **A secret key do Supabase não fica no runtime da API.** O mesmo deployment serve o site, e
  uma falha ali daria acesso à Admin API do Auth (gerar link de login para qualquer e-mail). A
  exclusão do usuário no Auth e a leitura do e-mail para o aviso final usam funções
  `SECURITY DEFINER` (`privacy.delete_auth_user` e `privacy.lookup_email_for_purge`),
  executáveis só por `privacy_system`. Se o spike S-PR-1 mostrar que isso não basta, a decisão
  é reaberta em novo ADR.
- **E-mails de login saem direto do Supabase Auth**, pelo SMTP do Resend configurado em
  `config.toml`, com templates por idioma em `supabase/templates/` (o idioma vem de
  `{{ .Data.locale }}`; spike S-AU-1). Só o e-mail de conta excluída sai pela API
  (`EmailSender`).
- **Pré-sequestro (S-AU-2, onda 6):** o cadastro com senha não pode deixar uma senha válida num
  e-mail que o dono ainda não provou ser dele. O plano B foi selecionado: o app cadastra por
  código e define a senha depois; a migration W6 adiciona um trigger em `auth.users` que apaga
  uma senha direta na primeira confirmação. O plano A foi rejeitado porque o GoTrue local manteve
  a senha do cadastro direto depois da confirmação pela vítima.
- **OTP (S-AU-4, onda 6):** 10 dígitos, 300 s e 10 verificações por 5 min por IP. Dez tentativas
  erradas não invalidaram o código correto e o agrupamento IPv6 `/64` não foi provado, portanto
  vale o plano B. O CI exige esses valores exatos no `config.toml` gerado
  (`pnpm supabase:config:check`, ADR 0014).
- **Troca de senha (S-AU-3b):** o app sempre envia o `nonce` de `reauthenticate()` e exige login
  recente. GoTrue 2.198 aceitou `updateUser({ password })` sem `nonce` numa sessão recém-autenticada;
  `secure_password_change` não é uma barreira contra chamada direta com sessão recente. O risco
  permanece registrado em R-ID-4.
- **Avisos de segurança:** GoTrue 2.198 tem configuração para avisos de troca de senha e e-mail,
  desligados por padrão. O template habilita as duas notificações e oferece conteúdo por idioma.
  A CLI 3.4.0 validou a configuração e os caminhos locais; entrega localizada ainda depende do
  teste contra a stack após a reinicialização controlada da Auth.
- **E-mail como orçamento e como reputação:** `email_sent` de 60 por hora (teto global),
  subdomínio de envio dedicado com SPF, DKIM e DMARC, teto de 300 contas novas por hora (hook
  `before_user_created`), alertas e runbook (identity-and-auth.md §3.7 e §3.8).
- **Versões derivadas** podem enviar os e-mails de login pela API, com o Send Email Hook do
  Supabase (assinatura Standard Webhooks), substituindo a porta `EmailSender`. É o que permite
  limitar o envio por destinatário.

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| Auth próprio | Muito código sensível para manter |
| Clerk ou Auth0 | Bons, mas somam um terceiro e custo por usuário ativo, além do Supabase já usado no banco |
| Validar com `auth.getUser()` a cada requisição | Uma ida ao Supabase por requisição; o JWKS é local e mais rápido. `getUser` fica para quem precisa do estado atual |
| Send Email Hook já no base-app | Exige mais código e uma rota de webhook; o aluno não precisa dele para ter login funcionando |

## Consequências

- **Não há limite de e-mails por destinatário no base-app.** O limite `email_sent` do Supabase
  é um orçamento do projeto inteiro, não por destinatário, então não impede que um atacante
  dispare muitos e-mails para a caixa de um terceiro nem que esgote o orçamento do projeto. Os
  rate limits por IP do Supabase Auth e o CAPTCHA (extensão) reduzem o risco, mas não o
  eliminam. O threat model registra isso como risco residual aceito (R3), condicionado ao teto
  `email_sent`, ao domínio dedicado, à conferência operacional de uso e ao runbook; o Sentry
  observa `over_email_send_rate_limit`. A mitigação completa por destinatário é o Send Email
  Hook das versões derivadas.
- `max_frequency = "60s"` bloqueou reenvio imediato ao mesmo endereço com 429
  `over_email_send_rate_limit`. As ações de auditoria local registradas foram
  `user_confirmation_requested`, `user_recovery_requested`,
  `user_reauthenticate_requested` e `user_modified`; a trilha não oferece contagem global
  confiável de `email_sent`.
- Mudanças de configuração do Auth passam por PR (`config.toml`) e são aplicadas com
  `supabase config push`; o painel não é editado à mão.
- Os e-mails de login dependem de SMTP próprio (Resend) por ambiente.
- Recursos do Auth que dependem de plano pago (proteção contra senhas vazadas, por exemplo)
  ficam ligados por ambiente quando o plano permitir.
- O servidor OAuth do Supabase para terceiros (token que é sessão completa) não é usado; se o
  app um dia expuser API ou MCP a terceiros, isso exige novo ADR.
- Um método de login extra e um provedor de CAPTCHA entram pelas extensões do app (ADR 0013).

## Proposta de aceite — spike S-TM-3 (2026-11-25)

### Ambiente e método

- Executado apenas no Supabase local descartável `app-base-w4-auth-spike`, na KVM
  `ci-r3`; nenhum projeto hospedado foi consultado ou alterado. Node.js 24.22.3,
  Supabase CLI 3.4.0, GoTrue v2.198.0, PostgreSQL 17.12.0.002, Kong 2.8.1 e
  Mailpit v1.31.3.
- A stack usou o baseline do repositório, com uma migration, e `db reset --no-seed`.
  Só a cópia temporária recebeu `auth.signing_keys_path` e uma chave ES256 gerada
  pelo CLI. A chave privada ficou em arquivo 0600 fora do checkout local. O
  projeto Docker e as portas publicadas ficaram limitados ao loopback: API
  `127.0.0.1:54421`, banco `54432`, pooler `54439` e Mailpit `54424` (SMTP
  `54425`, POP `54426`). `api.enabled` permaneceu `false`.
- O usuário de teste foi criado e confirmado pela Auth Admin API para permitir
  login por senha sem envio de e-mail. O SMTP não foi exercitado; isso não é uma
  evidência do fluxo de e-mail da onda 6.
- O harness `supabase/tools/w4-auth-spike.mjs` obtém o status do CLI apenas em
  memória, faz password sign-in e refresh reais no GoTrue, busca o JWKS local e
  verifica as assinaturas com a chave pública. A saída registra somente
  booleanos, algoritmo, audiência, nomes de claims e contagens.

### Evidência observada

- Os JWTs inicial e renovado usaram `alg = ES256`. O JWKS publicou uma chave
  pública e a assinatura dos dois tokens foi verificada por essa chave; nenhuma
  chave privada apareceu no JWKS.
- `iss` correspondeu ao emissor local
  `http://127.0.0.1:54421/auth/v1`, `aud = authenticated` e `role` foi aceito
  como `authenticated`.
- Claims presentes: `aal`, `amr`, `app_metadata`, `aud`, `email`, `exp`, `iat`,
  `is_anonymous`, `iss`, `phone`, `role`, `session_id`, `sub` e `user_metadata`.
  `is_anonymous` estava presente como `false`. `amr` tinha uma entrada de
  password sign-in com timestamp válido.
- Os nomes de claims em `app_metadata` foram `provider`, `providers` e `roles`.
  Após a emissão inicial, uma atualização Admin de papéis foi seguida por um
  refresh real: a contagem de papéis passou de 1 para 2, e a contagem de
  provedores permaneceu 1. O harness restaurou o estado inicial do fixture após
  registrar a comparação.
- O resultado local foi positivo para emissão e renovação de `roles` e leitura
  de `providers`, `is_anonymous`, `amr`, `iss`, `aud` e `alg`. O teste não altera
  o modelo de papéis, contrato, configuração versionada ou allowlist da API.

### Proposta e limites

A evidência sustenta marcar S-TM-3 como satisfeito para o fluxo local com ES256,
mantendo a decisão e as validações já descritas neste ADR e em
`identity-and-auth.md` §3.5. A allowlist de produção continua `ES256` e `RS256`;
este spike verificou ES256, sem relaxar HS256. O código de produção ainda precisa
validar os tokens com `jose` conforme a spec. Isto não prova SMTP, sign-in de
provedor social ou anônimo, execução do `AuthContext` da aplicação, nem qualquer
configuração ou comportamento hospedado.

Fontes Supabase consultadas: [JWT e JWKS](https://supabase.com/docs/guides/auth/jwts),
[JWT Signing Keys](https://supabase.com/docs/guides/auth/signing-keys),
[configuração da CLI](https://supabase.com/docs/guides/local-development/cli/config),
[referência da CLI](https://supabase.com/docs/reference/cli/supabase-config) e
[changelog de Auth](https://supabase.com/changelog?tags=auth).

## Evidência local W6 (2026-11-26)

As medições foram executadas no stack Supabase descartável `app-base-overnight-verify`, em
`ci-r3`, com CLI 3.4.0, GoTrue v2.198.0, PostgreSQL 17.12.0.002 e Mailpit. A API e o Mailpit
foram validados como loopback; todos os usuários e mensagens de fixture foram apagados após os
spikes. Nenhum projeto hospedado foi consultado ou alterado. A matriz detalhada está em
[`docs/plan/wave-6-auth-spikes.md`](../plan/wave-6-auth-spikes.md).

- S-AU-1 provou a seleção de ramo com marcadores para cinco tipos e fallback pt-BR para locale
  ausente, desconhecido ou de tipo inesperado. Uma regressão de conteúdo deixou o ramo EN vazio
  após um refactor; foi corrigida. O teste real EN verificou assunto, corpo, OTP, expiração e aviso
  de não compartilhamento; S-AU-3a verificou esses itens nos dois códigos de troca em PT/EN/ES.
- S-AU-2 provou que `verifyOtp({ type: 'signup' })` aceita cadastro direto, a senha do atacante
  permanece válida após a confirmação da vítima e cadastro somente por OTP aceita
  `verifyOtp({ type: 'email' })`. O plano B foi selecionado.
- S-AU-3a aceitou `email_change` nas duas caixas; a primeira confirmação manteve o e-mail antigo e
  a segunda alterou o endereço ativo. O aviso localizado chegou à caixa antiga e passou os checks
  de assunto e corpo em PT/EN/ES.
- S-AU-3b aceitou troca com e sem `nonce` numa sessão recém-autenticada. A ausência inicial do
  aviso de senha ocorreu com a notificação desabilitada na configuração do fixture; não foi
  evidência de que a versão não oferece o recurso. Após habilitar a configuração, os avisos de
  senha foram entregues e validados em PT/EN/ES.
- S-AU-4 aceitou o código correto após dez OTPs errados, não provou agrupamento IPv6 `/64`,
  bloqueou reenvio dentro de 60 s e identificou as ações de auditoria acima.
- A migration `identity.clear_unverified_password()` foi aplicada somente ao stack local
  descartável. O pgTAP local passou 14 arquivos/294 assertions, incluindo 6 assertions W6; o
  fluxo de pré-sequestro rejeitou a senha direta antes e depois da confirmação legítima, e aceitou
  cadastro OTP-only seguido de criação de senha e sign-in.

Referências de notificação: [guia local de templates do Supabase](https://supabase.com/docs/guides/local-development/customizing-email-templates)
e [configuração de Auth do GoTrue v2.198.0](https://github.com/supabase/auth/blob/v2.198.0/internal/conf/configuration.go).
