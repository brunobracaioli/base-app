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

S-TM-4 documenta a capacidade da CLI/config local; aplicar e conferir configuração
em projeto hospedado pertence ao checklist do derivado. Builds EAS assinados e
aceitação nativa do produto dependem de contas/configuração reais. Esses passos
não são simulados nem substituem as provas locais obrigatórias (base-app §2).

GitHub Actions permanece desativado. Nenhum deploy, compra, publicação em loja,
provisionamento ou migration de produção faz parte deste grupo.

## Decisões aprovadas em 2026-11-25

- **Sessão anterior:** manter o retorno genérico para dados simples inspecionáveis,
  inclusive `undefined`; recusar funções, getters, classes, ciclos e conteúdo com
  o token anterior. Limpar a sessão capturada em `finally`, sem encerrar a nova
  sessão primária. As assinaturas de entrada de base-app §3.4.2 permanecem vigentes.
- **HTTP anterior ao Proxy:** documentar a normalização e o 308 sem headers do app
  observados no Next. Host e prefixos continuam sendo conferidos no destino final;
  o checker TCP valida os redirecionamentos e o isolamento, sem prometer acesso
  à forma original que o framework descartou.
- **Baseline do Supabase:** aplicar o ADR 0016, com funções Auth restritas
  pertencentes a `postgres`, helpers mínimos de auditoria, reserva atômica do
  teto de cadastro e alertas persistidos sem `pg_net`. O dono autorizou consolidar
  as migrations experimentais ainda não publicadas e atualizar pontualmente a
  regra correspondente do AGENTS.md e as specs. Isso não autoriza alterar bancos
  existentes. Os testes de permissões continuam obrigatórios e executam as
  migrations com o papel normal `postgres`, sem superusuário para mascarar falhas.
