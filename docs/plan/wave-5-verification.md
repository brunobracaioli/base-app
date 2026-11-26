# Verificação da onda 5 — Configuração remota e gates

## Estado da entrega

Onda **✅ concluída como código do template** na branch `feat/w5-config-gates`,
worktree `/tmp/app-base-w5`. As quatro propostas foram aprovadas pelo dono;
[ADR 0017](../adr/0017-local-app-config-operations.md) fixa as decisões.
Sem push, PR, Actions, deploy ou alteração de banco hospedado.

## Evidências observadas

| Verificação | Resultado |
|---|---|
| Instalação congelada | Lockfile aprovado; sem dependência nova em W5 |
| CI completo | **18/18 gates**, checkout limpo e atestável, commit `8777573` |
| Workspace | **533 testes**: config 7, contracts 12, web 254, mobile 104, tooling 156; um teste condicionado separado |
| Lint/typecheck/arquitetura/formato | Aprovados; typecheck do operador faz parte do gate padrão |
| Drift/scans | OpenAPI, config e tipos sem drift; Semgrep, Gitleaks, OSV e Zizmor aprovados |
| Cobertura | Gate ≥80% por arquivo de domínio/aplicação preservado |
| Build/exports | Build web e bundles Hermes Android/iOS aprovados |
| Comandos prescritos W5 | Web **78 testes/9 arquivos**; mobile **30 testes/6 suítes** |
| Banco real | Migration aplicada como postgres; pgTAP **288 asserções/13 arquivos** |
| Cutover negativo | Evento legado preservado, erro 55000, nenhum objeto/migration W5 parcial criado |
| Tipos | Oito tabelas reais, TLS validado, sem drift |
| Harness API/banco | **24 checks** com SQL final; oito escritas, estado restaurado |
| CLI real | **38 checks**: assinaturas, privilégios, destino, adulteração, replay, force auditado e rollback; valores restaurados |
| HTTP real anterior | Nove checks públicos e 15 de gates; manutenção em 30,674 s e recuperação sem deploy; código HTTP preservado |

Recibos da conclusão ficam em `.artifacts/w5-completion/` no checkout principal;
provas HTTP anteriores em `.artifacts/w5-verification/`. O recibo completo de CI é
`.artifacts/ci/2026-11-26T02-15-43-963Z-ExdtFs/receipt.json` na worktree.
O teste condicionado não é contado como executado; as provas reais são separadas.

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
| Escrita só pela função, CAS, auditoria, ator e 20/21 por hora | pgTAP `w2_app_config_acceptance`, `w2_app_config_quota`, `w2_app_config_shape` e `w2_audit` e `w5_app_config_operations`; overload compatível, leitores restritos e auditoria reservada |
| App offline, atualização, manutenção e cache persistido | `evaluate-gate.test.ts`, `app-config-cache.test.ts`, `app-config-provider.test.tsx` e telas; offline só bloqueia por atualização |
| Timeout total, correlação, recuperação e sinais HTTP | `app-config-reader.test.ts`, `api-client.test.ts`, `app-providers.test.tsx`; limite 3 s, ID da tentativa ativa e atualização prevalece sobre manutenção |
| Guardas de salto, published, until, diff e plano de rollback | `scripts/app-config/operation.test.ts`, `operator.test.ts` e prova CLI real de set/rollback |
| Force auditado, rollback executável e autoaprovação recusada | `approval.test.ts`, `operator.test.ts`, pgTAP e prova CLI real com duas chaves efêmeras distintas |
| Limite global de detecção no app | ADR 0017: resposta até 150 s + polling foreground 60 s; até 210 s mais rede. `app-config-provider.test.tsx` cobre todos os gates, pausa e retomada |
| HIT da CDN e Maestro em dispositivo | Checklist do derivado/onda 12; não executados nem simulados |

## Limites e problemas resolvidos

O teste HTTP encontrou a sobrescrita do cache pelo Proxy. A correção permite
que somente GET exato de app-config delegue o cache ao handler; erros e rotas
privadas mantêm `no-store`, e extensões podem endurecê-lo. Regressão coberta
em `proxy.test.ts` e confirmada após novo build.

O harness usa repositório, composição, handlers e pipeline reais sobre PostgreSQL
TLS como `api_runtime`. Relógio, rate limit e logger são portas de teste. O
administrador descartável apenas prepara a prova e lê o token CAS; a escrita
assume `app_config_writer` e chama a função existente. O CLI foi exercitado separadamente por seus comandos pnpm reais, com login
sem privilégios elevados e apenas membership app_config_writer. Assinatura usa
chaves efêmeras de teste; não se afirma aprovação humana de produção. O teste HTTP
separado executa Next/Proxy reais.

A revisão corrigiu a ordem de gravação/limpeza do cache mobile, o ID de correlação
no timeout e a precedência do gate de atualização. Três testes RNTL 14 precisavam
aguardar `rerender()` assíncrono; a regressão passou após a correção. O guard de
arquitetura ganhou apenas as permissões exatas de API interna para os arquivos
do núcleo, com negativas para auth/composição e extensões. A primeira execução
de CI detectou esse guard e a seguinte detectou formatação; ambas foram corrigidas
e o recibo final contém todos os gates verdes.

A migration nova precisou substituir a aridade antiga sob seu proprietário
app_config_admin. A primeira tentativa falhou e foi integralmente revertida;
a correção ocorreu antes da aplicação bem-sucedida. Depois, a migration permaneceu
imutável. As falhas pgTAP seguintes eram de formato de expectativa e acesso ao schema
de testes; foram corrigidas sem modificar permissões de produção.

A prova CLI encontrou o caso de rollback de `{active:false}` histórico com campos
opcionais omitidos. A execução agora rederiva o plano validado da origem real e
compara toda a operação assinada, mantendo event ID/CAS exatos. O teste reproduziu
a falha antes da correção; a prova real completa passou depois dela.

A exceção Semgrep é limitada ao arquivo exato da migration W5, como a baseline W2;
o guard PostgreSQL AST verifica as assinaturas, contexto e propriedades exatas.
Não houve desativação de regras. O SQL usa comparação decimal sem overflow,
reserva a ação de auditoria em policy restritiva e recusa histórico legado sem
origem comprovada, sem apagar esse histórico.

Não há spike obrigatório próprio de W5. Contas reais, HIT da CDN, assinatura EAS
e testes em dispositivo permanecem no checklist do derivado, conforme base-app §2.

## Limpeza e próximo passo

Valores de configuração restaurados; login, senhas e chaves/planos efêmeros do
operador removidos. A stack Auth/Postgres/Mailpit e seu túnel foram transferidos
ao gerente para os spikes da onda 6, na execução contínua autorizada. Outros
workloads da KVM foram preservados. A stack compartilhada será removida ao final.

Próxima onda: **6 — login por e-mail**, iniciando pelos spikes S-AU.
