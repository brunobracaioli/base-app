# Responder a abuso de e-mail

Este runbook cobre o código do template. Ele não configura DNS, SMTP, Resend ou um projeto
Supabase hospedado; cada app derivado deve executar esses passos no ambiente autorizado.

## Controles e limites conhecidos

- `auth.rate_limit.email_sent = 60` é o orçamento global do projeto por hora, não um limite por
  endereço. A configuração aceita no mínimo 30 e no máximo 300.
- `auth.email.max_frequency = "60s"` bloqueia um reenvio imediato ao mesmo endereço. O spike
  local observou HTTP 429 `over_email_send_rate_limit` e nenhum segundo e-mail.
- OTP: 10 dígitos, 300 segundos e até 10 verificações por 5 minutos por IP. Dez códigos errados
  não invalidaram o código correto no GoTrue local. O agrupamento de IPv6 por `/64` não foi
  provado; não aumente esses limites com base nessa medição.
- A trilha Auth local registrou `user_confirmation_requested`, `user_recovery_requested`,
  `user_reauthenticate_requested` e `user_modified` para os fluxos provados. Ela não fornece
  uma contagem global confiável de `email_sent`; use a métrica de uso do projeto para o orçamento.
- Notificações de troca de senha e e-mail são recursos disponíveis no GoTrue 2.198. A ausência
  observada antes da mudança de configuração refletia `enabled = false`; não indicava falta de
  suporte. O template as habilita com conteúdo nos três idiomas.
- O Auth não impõe limite por destinatário. CAPTCHA não está ligado no núcleo; uma versão derivada
  pode configurá-lo pelo `CaptchaProvider` e pelo fragmento de configuração da extensão.

## Resposta a um alerta

1. Registre janela de tempo, serviço e contagens. Não copie e-mails, códigos, tokens ou conteúdo
   dos corpos para ticket, log ou chat. Para uma conta específica, use o UUID interno.
2. Verifique o consumo global de `email_sent`, a taxa de envio e os limites de bounce e reclamação
   do Resend. Trate 70% e 90% do teto como alertas operacionais; o spike não provou uma contagem
   global via `auth.audit_log_entries`.
3. Se o uso for inesperado, altere `auth.rate_limit.email_sent` em uma mudança revisada para o
   valor mínimo suportado (30 por hora) enquanto investiga. Gere e valide `config.toml`; aplique
   configuração hospedada apenas pelo operador autorizado e confira o valor aplicado.
4. Revise eventos `over_email_send_rate_limit` no Sentry sem anexar dados pessoais. Confirme se
   há CAPTCHA habilitado no app derivado antes de ampliar tráfego público; não invente ou habilite
   credenciais sem verificar provedor e segredo.
5. Se houver suspeita de chave SMTP exposta, crie uma chave substituta de envio restrito ao
   subdomínio dedicado, atualize o secret manager do ambiente, valide uma entrega controlada e
   revogue a chave antiga. Nunca cole a chave em arquivo, issue ou chat.
6. Revise bounces e reclamações com o Resend. Aja ao atingir bounce de 2% ou reclamação de 0,05%;
   os limites de suspensão do provedor são mais altos, não são metas de operação.

## Configuração e recuperação

- Mantenha o envio em subdomínio dedicado. Publique os registros SPF e DKIM fornecidos pelo
  provedor; acompanhe relatórios DMARC, use `p=quarantine` por 14 dias e só depois considere
  `p=reject`.
- Antes de aplicar uma alteração, rode `pnpm supabase:config`, `pnpm supabase:config:check` e
  `supabase config validate`. Revise o diff de `supabase/config.toml`; não o edite à mão. Se a
  CLI reportar referências `env()` sem resolver, confira os nomes no secret manager sem imprimir
  seus valores; `--resolve-env` só deve rodar num ambiente que injete esses segredos com segurança.
- Após aplicar uma mudança autorizada, valide os fluxos locais em Mailpit com contas descartáveis
  `example.invalid`. Confirme também os templates de aviso de senha e e-mail nas três línguas.
- Revise a reputação diariamente nas quatro primeiras semanas de envio e semanalmente depois.
  Retenha corpos de e-mail do provedor pelo menor período permitido pelo plano.

O risco residual de não existir um limite por destinatário está em
[`identity-and-auth.md` §3.8 e §6](../specs/identity-and-auth.md). Um Send Email Hook com quota por
destinatário continua sendo endurecimento para versões derivadas, não um recurso do núcleo.
