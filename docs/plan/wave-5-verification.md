# Verificação da onda 5 — Configuração remota e gates

## Estado da entrega

Onda **parcial, sem ✅** na branch `feat/w5-config-gates`, worktree
`/tmp/app-base-w5`. A `main` local integrou a onda 4 (`c690f28`). Não houve
push, PR, Actions, deploy ou mudança em banco hospedado.

Contrato, servidor, mobile e planejamento puro da operação estão implementados
e verificados. O CI completo passou em `fa3ef94`, com recibo limpo e atestável. Os leitores
SQL, setter com force auditado e executor com duas pessoas aguardam as decisões
em [wave-5-execution.md](wave-5-execution.md). A aprovação não foi presumida.

## Evidências já observadas

| Verificação | Resultado |
|---|---|
| Instalação congelada | Lockfile aprovado em 1494 entradas; sem dependência nova |
| Contratos | 12 testes, lint, typecheck e OpenAPI 1.2.0 aprovados |
| Planejamento da operação | 19 testes; sem conexão ou escrita no banco |
| Web | Lint/typecheck e 224 testes aprovados; um teste condicionado à conexão |
| Cobertura web | Novos arquivos de domínio/aplicação app-config com 100% de linhas; gate por arquivo ≥80% preservado |
| Build web | Produção compilada, incluindo `/api/v1/app-config` |
| Banco real | Reset aprovado; pgTAP 12 arquivos/238 asserções |
| Tipos | `pnpm db:types`: oito tabelas reais, sem drift; TLS validado |
| Harness real | 24 checks aprovados no código `fc22ac2`, oito escritas pela função existente, valores restaurados |
| HTTP real | Nove checks públicos e 15 de gates aprovados; manutenção observada em 30,674 s, recuperação sem deploy |
| Mobile | Lint/typecheck e 100 testes aprovados em 18 suítes |
| CI completo | 18/18 gates, 496 testes + um condicionado à conexão; commit `fa3ef94` |
| Verificação prescrita W5 | Web 48 testes/7 arquivos; mobile 26 testes/6 suítes |
| Exports mobile | Android e iOS, bundles Hermes compilados; sem assinatura/EAS |

Recibos locais ficam em `.artifacts/w5-verification/` no checkout principal:
`live-proof-final.json`, `http-public.json`, `http-gates.json`,
`pgtap-baseline.log`, `final-ci-receipt.json`, logs de build/tipos/exports e `cleanup.json`.
O recibo completo original está em
`.artifacts/ci/2026-11-26T00-27-50-817Z-U3JE53/receipt.json` na worktree.
Distribuição: config 7, contracts 12, web 224, mobile 100, tooling 153.
O teste condicionado não é contado como executado; a prova real é separada.

## Critérios de aceite

| Critério | Prova / situação |
|---|---|
| Endpoint público, sem dados de usuário, query independente e cache correto | `app/api/v1/app-config/route.test.ts`, `core-routes.test.ts`; nove checks HTTP reais |
| 426 por versão, comparação numérica, headers inválidos e precedência | `modules/app-config/tests/settings.test.ts`; harness `route.numeric_minimum`; HTTP `old_version_426` |
| Manutenção em todos os métodos de rotas não isentas | `get-app-config.test.ts`, pipeline e harness `gate.maintenance_all_methods`; GET/PATCH me e POST consents no HTTP real |
| Health/app-config isentos; exceção de manutenção não ignora versão/auth | Domínio/pipeline/runtime; harness e HTTP `health_exempt`/`config_exempt` |
| Servidor bloqueia em ≤60 s sem deploy | Relógio injetado em `get-app-config.test.ts` e harness `cache.after_30000ms`; HTTP real 30,674 s |
| Valor inválido/ausente usa último válido por chave ou padrão e alerta | Query/repositório; harness `fallback.invalid_setting` com dado real aceito pelo SQL e recusado pelo Zod |
| URLs apenas do produto; published não exposto | Query/repositório/rotas; harness `route.published_absent` e HTTP |
| APP_CONFIG_KEYS, schemas, função SQL e constraint coincidem | Teste do módulo e catálogo real em `db.key_allow_list_parity` |
| Escrita só pela função, CAS, auditoria, ator e 20/21 por hora | pgTAP `w2_app_config_acceptance`, `w2_app_config_quota`, `w2_app_config_shape` e `w2_audit`; interfaces novas pendentes |
| App offline, atualização, manutenção e cache persistido | `evaluate-gate.test.ts`, `app-config-cache.test.ts`, `app-config-provider.test.tsx` e telas; offline só bloqueia por atualização |
| Timeout total, correlação, recuperação e sinais HTTP | `app-config-reader.test.ts`, `api-client.test.ts`, `app-providers.test.tsx`; limite 3 s, ID da tentativa ativa e atualização prevalece sobre manutenção |
| Guardas de salto, published, until, diff e plano de rollback | `scripts/app-config/operation.test.ts`, 19 testes; execução real de set/rollback pendente |
| Force auditado, rollback executável e autoaprovação recusada | Pendente de decisão e implementação; não certificado por testes do planejador |
| Limite global de detecção no app | Pendente de esclarecimento: idade do cache não equivale ao instante de detecção em tela |
| HIT da CDN e Maestro em dispositivo | Checklist do derivado/onda 12; não executados nem simulados |

## Limites e problemas resolvidos

O teste HTTP encontrou a sobrescrita do cache pelo Proxy. A correção permite
que somente GET exato de app-config delegue o cache ao handler; erros e rotas
privadas mantêm `no-store`, e extensões podem endurecê-lo. Regressão coberta
em `proxy.test.ts` e confirmada após novo build.

O harness usa repositório, composição, handlers e pipeline reais sobre PostgreSQL
TLS como `api_runtime`. Relógio, rate limit e logger são portas de teste. O
administrador descartável apenas prepara a prova e lê o token CAS; a escrita
assume `app_config_writer` e chama a função existente. Isso não prova o CLI
operacional ainda pendente. O teste HTTP separado executa Next/Proxy reais.

A revisão corrigiu a ordem de gravação/limpeza do cache mobile, o ID de correlação
no timeout e a precedência do gate de atualização. Três testes RNTL 14 precisavam
aguardar `rerender()` assíncrono; a regressão passou após a correção. O guard de
arquitetura ganhou apenas as permissões exatas de API interna para os arquivos
do núcleo, com negativas para auth/composição e extensões. A primeira execução
de CI detectou esse guard e a seguinte detectou formatação; ambas foram corrigidas
e o recibo final contém todos os gates verdes.

A prova real do harness foi repetida no código `fc22ac2` após seu ajuste de input.
Depois houve somente formatação no servidor/harness; os gates finais verificam
o código formatado. O fechamento posterior altera apenas Markdown.

Não há nova migration nem spike obrigatório nesta onda até aqui. A comparação
SQL com `int[]`, a origem confiável do rollback e o substituto do Actions estão
na proposta; as proteções existentes não foram relaxadas.

## Limpeza e próximo passo

Stack, volumes, rede, arquivos/credenciais/TLS da KVM, servidor Next local e
túnel SSH removidos. Os demais workloads foram preservados. Os inputs privados
da prova já não existem; outro run exige fixture novo e isolado.

Os gates independentes estão concluídos. Obter as decisões registradas e terminar a
operação antes de marcar a onda 5 ou iniciar a onda 6. Nenhuma conta, segredo
ou publicação é necessária para responder às decisões do template.
