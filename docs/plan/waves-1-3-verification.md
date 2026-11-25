# Verificação das ondas 1, 2 e 3

Fundação do template concluída localmente em 2026-11-25, conforme base-app §2.
A integração está em `chore/template-foundation-integration`, na worktree
`/tmp/app-base-template`. A `main` permanece em `cda886d`; não houve novo push,
PR, deploy nem alteração de projeto hospedado. A v1 completa ainda depende das
ondas 4–12.

As três ondas usaram sessões/worktrees próprias com Luna/xhigh, com revisão e
integração centralizadas. A regra de Auth do AGENTS.md foi alterada somente na
extensão aprovada pelo dono; o guia existente foi preservado.

## Comandos e alcance das provas

| Verificação | Resultado |
| --- | --- |
| `pnpm ci:local` | 18 gates aprovados em checkout limpo; recibo vinculado ao commit `d941c41` |
| `pnpm turbo run lint typecheck test` | 17 tarefas; 328 testes aprovados e 1 teste condicionado à conexão real |
| `pnpm architecture:check` | Sem violações; inclui negativas para extensões mobile em `features/custom` |
| Formatação, geração/drift OpenAPI e configuração Supabase | Passaram |
| Lint de migrations e limites de escrita em auditoria | Passaram; uma baseline consolidada e registro Auth fechado |
| Semgrep, Gitleaks, OSV e Zizmor | Passaram; fixture inseguro do Zizmor retorna a rejeição esperada |
| `pnpm --filter web build` | Passou, em modo de produção |
| Checker TCP de W1 com extensão temporária | Passou nos 13 casos de host/prefixo/destino normalizado; registro vazio não alega teste de prefixo e retorna `incomplete` por desenho |
| `supabase start` e `supabase db reset` | Passaram na KVM isolada, como `postgres` sem superusuário |
| `supabase test db` | 11 arquivos, 198 asserções, PASS; execução pelo helper versionado também passou |
| Probe concorrente | 301 chamadas: 300 aprovações e uma rejeição 429; duas escritas após 19: uma confirma e outra recebe SQLSTATE 54000 |
| GoTrue + Mailpit reais | Cadastro 200 gera usuário/reserva/mensagem; falha SMTP 500 mantém reserva sem criar usuário; Mailpit restaurado |
| GoTrue com 300 reservas | HTTP 429; nenhum usuário, reserva ou e-mail adicional |
| `pnpm db:types` + `git diff --exit-code` | Seis tabelas geradas do banco real; sem drift em relação aos tipos commitados |
| Adaptador Kysely pelo pooler TLS | Prova real anterior preservada: fontes executáveis idênticas por SHA-256; bind, isolamento, rollback, microssegundos e auditoria atômica verificados |
| Mobile: Jest/RNTL, lint e typecheck | Passaram; 12 suítes/67 testes |
| Exports Expo Android/iOS | Passaram com a fachada final; configuração/prebuild anteriores continuam válidos, sem alteração de configuração nativa |

O teste de conexão condicionado não é contado como executado pela suíte unitária.
Sua evidência é o harness real do adaptador, separado dos fakes. A comparação
registrada mostra alteração apenas nos tipos gerados, sem mudança do código de
conexão/auditoria. Recibo final: `.artifacts/ci/2026-11-25T19-25-59-231Z-PC7MCc/receipt.json`. Artefatos complementares ficam
em `.artifacts/template-foundation/` na raiz do checkout principal.

## Onda 1 — critérios de aceite

Caminhos relativos a `apps/web/src/platform/`.

| Critério | Teste/prova | Estado |
| --- | --- | --- |
| Auth obrigatório por tipo | `http/define-route.type.test-d.ts` | ✅ |
| Toda rota usa defineRoute; públicas iguais ao contrato | `http/route-contract.test.ts` | ✅ |
| Extensão fake, registros vazios e colisões | `extensions/composition.test.ts` | ✅ |
| Redaction de logs/Sentry | `observability/redaction.test.ts` | ✅ |
| Replay, lease, chave em andamento e hash diferente | `http/define-route.test.ts`, `http/idempotency-store.test.ts` | ✅ |
| Erros sem internals, Retry-After e falhas de políticas/driver | Testes do pipeline HTTP | ✅ |
| Balde global, limite de body e rotação de segredos | `http/body.test.ts`, `http/webhook-verifiers.test.ts` e pipeline | ✅ |
| Host/prefixo, CSP e listas vazias | `edge/host-policy.test.ts`, `edge/csp.test.ts` e checker TCP | ✅ |
| Auditoria fail-closed/subjectRef/transação | `audit/audit.test.ts`, pgTAP e harness Kysely real | ✅ |
| CAPTCHA widget único | `extensions/composition.test.ts` | ✅ |
| CSP estrita e headers de extensão | `edge/csp.test.ts`, testes de composição | ✅ |
| Paths proibidos ou normalizados, sem atravessar host/prefixo | Checker TCP em produção com fixture temporário, ADR 0003 | ✅ |
| publicEnv restrito | `extensions/composition.test.ts` | ✅ |
| Headers independentes e exclusão sem nonce | S-TM-2, `http/security-headers.test.ts`, rota account-deletion | ✅ |
| IP compartilhado, request IDs e rate failure explícito | Testes de pipeline/IP/rate-limit/request-id | ✅ |
| Isenção de manutenção restrita | Testes de tipo, rota e pipeline | ✅ |
| Suítes de contrato e isolamento de export | `testing/contracts/contracts.test.ts` | ✅ |

O aceite HTTP segue a decisão aprovada: respostas pré-Proxy do Next são
identificadas separadamente; Location e destino final são validados. Não se
alega que o Proxy recebeu a forma original que o framework normalizou.

## Onda 2 — critérios de aceite

Caminhos relativos a `supabase/tests/`.

| Critério | Teste/prova | Estado |
| --- | --- | --- |
| Papéis, ACLs, ownership, RLS e registro Auth exato | `w2_catalog_privileges.test.sql` | ✅ |
| Claims hostis por bind, pooler e TLS | S-DB-1 e harness do adaptador real | ✅ |
| Expurgo apenas de vencidos, lotes, zero e heartbeat | `w2_ops_purge_expired.test.sql` | ✅ |
| Escritores de auditoria, negação de operator e grupos | `w2_audit.test.sql`, catálogo e fixtures JSON | ✅ |
| Config gerada, fragmentos, invariantes e drift | Testes/CLI de `supabase-config` | ✅ |
| CAS e eventos atômicos de settings | `w2_app_config_acceptance.test.sql` | ✅ |
| Leitor, allowlist, GUC forjado e fronteiras gerenciadas | Catálogo, auditoria e fixtures privados de Storage/Realtime | ✅ |
| Contas não confirmadas, preservação de anônimos/recentes/sem e-mail | `w2_unconfirmed_purge_acceptance.test.sql`, `w2_unconfirmed_backlog_acceptance.test.sql` | ✅ |
| Sinais e os três agendamentos | `w2_ops_signals.test.sql`, `w2_ops_purge_expired.test.sql` | ✅ |
| Forma/ator/cota de settings e rollback | `w2_app_config_shape.test.sql`, `w2_app_config_quota.test.sql`, aceite | ✅ |
| Idempotência por usuário e reassunção de lease | `w2_idempotency.test.sql` | ✅ |
| Hook, 300/301, falha posterior e concorrência 20/21 | `w2_signup_hook.test.sql`, probe concorrente e GoTrue/Mailpit reais | ✅ |
| Spikes e tipos gerados | ADRs 0005/0014, `pnpm db:types` sem drift | ✅ |

Migrations usam `postgres`; o administrador descartável só prepara fixtures e
assume os papéis de teste, sem conceder privilégios ausentes na aplicação. O
probe concorrente também usa os chamadores reais dentro de transações com
`SET LOCAL`; a pré-carga de auditoria passa por `app_config.set_setting`.

A baseline não instala `pg_net`; alertas ficam em `ops.alerts`. O mapeamento de
volume de e-mail permanece no S-AU-4, conforme a revisão aprovada do ADR 0008.
Não houve criação de projeto hospedado nem substituição de grants por
superusuário para fazer a suíte passar.

## Onda 3 — critérios de aceite

Caminhos relativos a `apps/mobile/`.

| Critério | Teste/prova | Estado |
| --- | --- | --- |
| Headers, rota pública, refresh e tradução | `src/shared/api-client/api-client.test.ts` | ✅ |
| Montagem vazia e extensão fake | `src/features/shell/ui/app-providers.test.tsx` | ✅ |
| CAPTCHA único | `src/extensions/registry.test.ts` | ✅ |
| Fachada, resultado seguro e limpeza da sessão anterior | `src/extensions/api.test.tsx` — 15 casos, incluindo falhas e preservação da nova sessão | ✅ |
| Sem resumo antigo e lifecycle de CAPTCHA | Regressões de troca de SessionPort, falhas/release e dispose compartilhado no teste da fachada | ✅ |
| Extensão não acessa sessão crua | Negativas do dependency-cruiser em `features/custom`, helpers, rotas e registros; testes públicos de tipo | ✅ |
| publicEnv e contexto sem tokens | Registry e `types.type-test.ts` | ✅ |
| HTTPS/allowlist/ATS e rotas sem ação ao montar | URL/app config, arquitetura, providers e parâmetros | ✅ |
| Paridade de traduções | `src/shared/i18n/check-locale-parity.test.ts` | ✅ |
| Configuração e bundles das duas plataformas | Config/prebuild locais e exports Android/iOS | ✅ |

Não foram executados EAS assinado nem testes em aparelho. Os exports registram
warnings do resolvedor do expo-router e da configuração ainda vazia do Sentry;
concluíram com exit 0. A implementação real do cliente secundário Supabase é da
onda 6; a onda 3 entrega sua porta e prova o contrato com fakes.

## Decisões, problemas resolvidos e próximos passos

O dono aprovou a restrição de retorno da fachada, as exceções pré-Proxy do Next
e o ADR 0016. A investigação corrigiu o modelo de grants incompatível, a cota
concorrente, a purga de e-mails vazios e o acesso às contagens de auditoria.
A revisão mobile corrigiu assinaturas, resumo obsoleto, dispose duplicado e
imports privados fora da pasta de registros. Testes de alerta agora isolam
seus dados dentro de uma transação, sem depender do horário do cron.

As antigas falhas de pgTAP e tentativas de CI permanecem como histórico nos
artefatos; não foram convertidas em skips nem aceitas silenciosamente. A
consolidação de migrations vale somente para o template experimental aprovado.
Projetos com a baseline antiga precisam de um plano de atualização próprio.

Não é necessária conta externa para aceitar estas fundações. Para instanciar o
produto, siga o guia de desenvolvimento e a referência de variáveis, mantendo
segredos em `.env.local`/gerenciador e valores vazios nos exemplos. A confirmação
hospedada do S-TM-4, EAS/assinatura e lojas pertencem ao derivado.

A limpeza confirmou zero containers, volumes e redes desta verificação; o
diretório descartável, as credenciais e o túnel SSH foram removidos. Os demais
workloads da KVM foram preservados.

Próxima onda: **4**, depois da integração desta branch na base de trabalho. No DAG, W8/W9 podem executar em paralelo após W7; W10 pode
se sobrepor a W8 depois de W9. Nenhuma dessas ondas foi adiantada aqui.
