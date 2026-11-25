# Execução paralela das ondas 1, 2 e 3

Base: `cda886d79afbf4b1f61068b8d9a4614d8603ffdc`, merge autorizado do PR #2.
A tree `9333655973772103a86ca80ca5864d93510feeba` coincide com a da onda 0 validada.
O dono autorizou este grupo; cada sessão de implementação executa somente sua
onda em branch/worktree próprias, com agentes Luna/xhigh.

## Ownership e ordem

| Onda | Branch / worktree | Arquivos |
| --- | --- | --- |
| 1 | `feat/w1-api-platform`, `/tmp/app-base-w1` | `apps/web`, exceto `src/platform/db`; contratos necessários ao pipeline; spike S-TM-2 |
| 2 | `feat/w2-supabase-baseline`, `/tmp/app-base-w2` | `supabase`, `apps/web/src/platform/db`, harness e scripts de banco; spikes S-DB-1 e S-TM-4 |
| 3 | `feat/w3-mobile-shell`, `/tmp/app-base-w3` | `apps/mobile`, ferramentas/testes mobile, configuração Expo/EAS; nenhuma feature de login/billing antecipada |

O gerente mantém este plano, `NOTES.md`, roadmap, contratos compartilhados,
revisão e integração. Manifest do app web pertence à onda 1; a onda 2 informa
suas dependências e valida seu código isoladamente até integrar o scaffold.
Lockfiles são integrados em série. O merge de uma onda é conferido antes de
rebasear a próxima; nenhum agente faz push/merge ou altera outro checkout.

## Contratos de coordenação

- DB: `userScopedDb(claims, work(trx))` e `systemDb(context, work(trx))`, ambos
  transacionais. `SystemContext`: `identity`, `privacy`, `app-config`, `platform`;
  mapeamento fixo para os papéis SQL, com `app-config` → `app_config_system`.
- `DbTransaction` é exportado pelo `platform/db/index.ts`; o audit recebe a
  transação/papel do chamador, sem escalá-lo nem abrir outra transação.
- A permissão de inserção em auditoria pelos papéis do núcleo já está explícita
  na spec de privacidade §4.1; não exige novo grant de `audit_writer` ao núcleo.
- Idempotência tem porta injetável na onda 1 e adapter transacional; a tabela e
  os testes de banco pertencem à onda 2. Fakes não são prova de persistência.
- Rotas de extensão continuam arquivos `route.ts`; não se cria um método novo
  de registro de rotas. O fixture combina rota de filesystem, handler e override.
- JWT real é onda 4, fluxos de login são onda 6 e fábrica/uso da purga são onda 9.
  As fundações usam portas e falham fechado quando uma implementação não existe.
- As ondas 1 e 3 podem estender metadados/tipos compartilhados apenas por mudança
  coordenada. Nenhuma chave, ID de produto ou conta é inventado.

## Plano de aceite antes de implementar

| Área | Arquivos previstos | Prova |
| --- | --- | --- |
| Spike HTTP | app de spike isolado, ADR 0003 | Next real: API, página, asset público e `/_next/static`, com/sem Proxy; CSP/nonce e matcher |
| Pipeline HTTP | `platform/http` e testes | auth/rate failure obrigatórios por tipo; ordem; limites de corpo/IP; autorização fail-closed; replay e lease via fake |
| Borda | `proxy.ts`, config Next, `platform/http`/extensões | tabela de hosts/paths/CSP/headers; 503 sem nonce; publicEnv restrito |
| Extensões/observabilidade | `platform/extensions`, audit/logger/testing | registro vazio/fake, colisões, contratos das portas, redaction, transação audit propagada |
| Banco/pooler | `platform/db`, scripts do spike, ADR 0005 | `set_config` com bind, payload com aspas/semicolon, isolamento após commit/reuso, TLS verificado |
| Schema e papéis | migrations + `supabase/tests` | pgTAP: grants, membership, RLS forçado, acesso cruzado, funções/ownership, GUC forjado |
| Config/rotinas | config fonte/gerado, SQL, ADR 0008/0014 | drift; valores protegidos; retenção/lotes; limites do hook, alerts, concorrência de settings/idempotência |
| Client mobile | `features`/`shared/api-client` e testes | headers, rota pública sem token, refresh único, erro traduzido e descarte de respostas antigas |
| Casca/extensões mobile | rotas, composição, i18n, tema | montagem sem extensões e com fake; unicidade CAPTCHA; nenhuma ação em mount das rotas |
| Sessão/fachada mobile | auth adapters e `extensions/api.ts` | token anterior só no callback, limpeza finally, sem escape em log/storage/retorno, CAPTCHA consistente |
| Configuração nativa | app.config/eas e testes | HTTPS/allowlist, publicEnv, backup/R8/ATS; builds EAS reais só com contas/projetos autorizados |

Cada agente mantém a matriz detalhada de sua onda no handoff e associa os
critérios da spec aos testes executados. A verificação final usa `pnpm ci:local`
em checkout limpo e inclui os gates específicos da onda. Não se troca gate
real por fixture ou documentação.

## Execução de banco e limites operacionais

A onda 2 usa uma KVM existente, por SSH já configurado, em namespace e workdir
próprios. Nenhum container de outros projetos é parado; nenhum `.env` do
operador é enviado. Serviços de teste ficam em loopback/rede interna, com
credenciais efêmeras geradas pelas ferramentas e saída sanitizada.

S-TM-4 distingue CLI/config local de aplicação num projeto Supabase hospedado;
sem projeto autorizado, a prova hospedada fica pendente. Builds EAS e aceitação
nativa dependem de contas/configuração reais. Essas ausências são registradas,
e a onda correspondente não é marcada completa sem seus critérios obrigatórios.

GitHub Actions permanece desativado. Nenhum deploy, compra, publicação em loja,
provisionamento ou migration de produção faz parte deste grupo.

## Propostas pendentes de decisão do dono

Estas propostas não alteram os contratos vigentes nem autorizam grants.

- **Sessão anterior (mobile-app-shell §3.8):** preservar o retorno genérico
  de `withPreviousSession<T>` para dados inspecionáveis, inclusive `undefined`;
  recusar funções, getters, instâncias opacas e ciclos. O token é recusado em
  qualquer chave/valor e erros são sanitizados, com limpeza em `finally`.
- **Requisição anterior ao Proxy (ADR 0003):** decidir entre documentar a
  normalização/308 sem headers observada no Next e exigir um ingress anterior
  que cumpra o 404 exato. Host e prefixos continuam sendo conferidos no path
  entregue ao Proxy; isso não prova que a forma original foi rejeitada.
- **Permissões internas de auditoria (app-config §4, privacidade §4.1 e
  ADR 0008):** a função `set_setting`, dona `app_config_admin`, precisa contar
  eventos para impor 20 alterações/hora, mas não tem SELECT; a purga, dona
  `auth_fn_owner`, precisa gravar sua contagem, mas não tem INSERT. Proposta:
  duas funções privadas `SECURITY DEFINER`, donas de `ops`, com
  `search_path = ''`: uma sem parâmetros que devolve somente a contagem de
  `app_config.updated` na última hora, executável apenas por `app_config_admin`;
  outra recebe apenas a contagem não negativa da purga e grava um evento fixo
  `ops.purge_unconfirmed_users`, executável apenas por `auth_fn_owner`.
  Revogar EXECUTE de PUBLIC e dar aos chamadores somente USAGE no schema e
  EXECUTE na respectiva função; nenhum acesso direto adicional à tabela.
  pgTAP deve provar dono/search_path, grants exatos, negativas dos demais
  papéis e que os argumentos não permitem escolher evento, ator ou usuário.
  Alternativa a decidir: grants de tabela/coluna e políticas RLS estreitas.
- **Sinais ainda sem implementação verificável na onda 2:** a contagem de
  contas não confirmadas exige acesso a `auth.users`; não foi concedido SELECT
  a `ops`, pois funções definidoras que acessam `auth` devem pertencer a
  `auth_fn_owner`. Um contador privado desse dono, executável por `ops`, é uma
  proposta adicional, ainda sem aprovação. Os alertas de 70%/90% de envio de
  e-mail também dependem do mapeamento real de eventos do Auth (S-AU-4,
  atualmente planejado na onda 6). Nenhum evento ou resultado de envio foi
  inventado para satisfazer esses critérios; o plano precisa resolver essa
  dependência antes de concluir a onda 2.
