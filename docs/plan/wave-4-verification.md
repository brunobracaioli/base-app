# Verificação da onda 4 — Auth, perfil e consentimentos

Estado em 2026-11-25: concluída localmente como parte do template de desenvolvimento.
Branch `feat/w4-auth-profile-consents`, worktree `/tmp/app-base-w4`, criada a partir
da `main` local `4261bce` após integrar as fundações verificadas. Sem push, PR,
deploy, projeto hospedado ou implementação das ondas 5+.

## Entrega

- Contratos e OpenAPI 1.1.0 antes dos handlers: GET/PATCH `/v1/me` e POST
  `/v1/me/consents`, com bodies estritos, erros estáveis e sucesso 204 sem corpo.
- Verificador JOSE compartilhado: ES256/RS256, issuer/audience, exp/iat e claims,
  JWKS com cache/cooldown/timeout, marcador de exclusão fechado em falha,
  `AuthContext` completo e apenas quatro claims no banco.
- Perfil e consentimentos em vertical slices, com domínio e aplicação puros,
  repositórios Kysely, versões legais por porta, composição lazy e handlers de
  purga vinculados à transação fornecida. A orquestração de exclusão é da W9.
- Migration W4 nova e imutável, duas tabelas com RLS forçado e helper estreito
  `identity.read_fresh_roles(uuid)` registrado e limitado ao próprio usuário.
- Logs estruturados de conclusão com correlação/UUID e sem payload, e-mail ou
  token. Métricas existentes: `api.request.outcome` e `api.request.duration_ms`.

## Comandos e evidências

| Comando/prova | Resultado |
| --- | --- |
| `pnpm ci:local` | 18 gates aprovados, checkout limpo e recibo atestável do commit `f4fb085` |
| Workspace: lint, typecheck e testes | 17 tarefas; 405 testes aprovados, 1 teste condicionado à conexão real |
| Web completo com cobertura | 173 testes aprovados e 1 condicionado; mínimo de 80% imposto por arquivo de domain/application |
| Cobertura | Statements 95,68%; branches 92,30%; functions 100%; lines 97,14%. Application: 100% nas quatro métricas |
| `pnpm --filter web test -- identity privacy` | Passou: 9 arquivos, 25 testes; o runner agora encaminha os filtros |
| `pnpm --filter web build` | Passou; inclui `/api/v1/me` e `/api/v1/me/consents` |
| Arquitetura, formatação e lint de migrations | Passaram, sem afrouxar boundaries nem regras de segurança |
| OpenAPI/configuração gerados e drift | Passaram no gate integrado |
| `pnpm db:types` + `git diff --exit-code HEAD -- apps/web/src/platform/db/types.ts` | 8 tabelas do banco real; sem drift |
| `supabase migration up` | Passou somente na stack local descartável, como `postgres` sem superusuário |
| `supabase test db` | 12 arquivos, 238 asserções, PASS |
| Harness real da API | 22 verificações aprovadas com GoTrue/JWKS e PostgreSQL TLS reais |

Recibo do código: `.artifacts/ci/2026-11-25T22-33-03-070Z-2xJwas/receipt.json`.
As atualizações posteriores de status são somente documentação, verificadas
com Prettier e `git diff --check`. Artefatos duráveis ficam em
`.artifacts/w4-verification/` no checkout principal.

O teste de conexão condicionado não é contado como executado pela suíte
unitária. A prova real separada executou os handlers, o verificador, os casos
de uso e os repositórios efetivos contra GoTrue e banco TLS, com `api_runtime`.
Somente rate limiter, leitor do marcador de exclusão, relógio e logger foram
substituídos nas portas. O teste não alega ter exercitado Upstash hospedado.

## Critérios de aceite

| Critério | Teste/prova | Estado |
| --- | --- | --- |
| JWT real válido → 200; assinatura/alg inválidos → 401; expirado → `auth.token_expired` | `platform/auth/verifier.test.ts` e `scripts/w4-api-proof.ts` | ✅ |
| JWKS fixo, sem redirecionamento por jku/x5u; cache/cooldown/timeout | Testes do verificador, sem rede externa; S-TM-3 confirma JWKS real | ✅ |
| UUIDs/role/aal/amr e tempo válidos; token limitado antes de verificar | Testes do verificador e pipeline | ✅ |
| `is_anonymous` ausente → false; roles/providers inválidos → []; avisos sem valores | Testes do verificador; nenhuma dessas propriedades entra em dbClaims | ✅ |
| `verifyAccessToken` público e autenticação do pipeline têm o mesmo resultado | `platform/http/auth-pipeline.test.ts`: válido, none, expirado e conta excluída | ✅ |
| Rota fake protegida verifica segundo token do body e não vaza tokens rejeitados | `auth-pipeline.test.ts`, com logs capturados e header válido/body inválido | ✅ |
| Marcador de exclusão presente nega; falha de leitura dá 503/Retry-After | `platform/auth/deleted-marker.test.ts`, verificador e harness real com port fake | ✅ |
| Usuário A não lê/altera perfil ou consentimento de B | `supabase/tests/w4_profile_consents.test.sql`, `core-routes.test.ts` e harness real | ✅ |
| Perfil nasce uma vez mesmo com GETs concorrentes | Query de get-me, repositório e prova real com usuário B novo | ✅ |
| PATCH estrito, normalização de nome e locale permitido | Domínio, aplicação, core-routes e prova real; erro `validation.failed` | ✅ |
| `Me.createdAt` é a data da linha de perfil | Contrato, mapper e comparação com o banco no harness real | ✅ |
| FK de conta excluída vira 401 sem detalhes de banco | Teste de rota com driver fake 23503 passando pelo repositório real | ✅ |
| Consentimento atual → 204; retry preserva a mesma linha/timestamp; antigo → 409 | Domínio/aplicação/core-routes, pgTAP e harness real | ✅ |
| Papéis frescos vêm do banco sem refresh do JWT e sem ler outro usuário | Teste do reader, pgTAP e atualização Admin somente do fixture local | ✅ |
| Purga por contexto usa a transação fornecida, papel próprio e permite rollback | Testes de infraestrutura dos handlers de identity/privacy | ✅ |
| Domínio/aplicação têm cobertura mínima efetivamente imposta | `vitest.config.ts` com `thresholds.perFile: true`; relatório da execução completa | ✅ |
| Logs de sucesso/rejeição têm correlação e não contêm dados sensíveis | Testes de conclusão do pipeline, redaction e teste do segundo token | ✅ |

Caminhos de testes web são relativos a `apps/web/src/`.

## Spike S-TM-3 e decisões aprovadas

O spike usou Supabase CLI 3.4.0, GoTrue v2.198.0 e PostgreSQL 17.12.0.002.
Password sign-in e refresh reais emitiram ES256 validado pelo JWKS. As claims
issuer/audience/role/aal/amr/is_anonymous foram conferidas; a alteração Admin
levou roles de uma para duas entradas após refresh, mantendo providers.
O resultado e as fontes estão no ADR 0004, no mesmo commit do harness.

O usuário fixture foi confirmado pela Admin API. Não foi validado o fluxo
mobile/SMTP da onda 6, nem foi habilitado login anônimo ou social no produto.

O dono aprovou explicitamente: Redis fechado para as três rotas e o marcador;
helper Auth restrito com UUID igual a auth.uid(); e data de criação do perfil
em `Me.createdAt`. O helper segue o ADR 0016, sem grant direto em Auth nem
chave administrativa no runtime da API.

## Problemas corrigidos e limites

Foram corrigidos: resposta sempre 200 do pipeline; erro Auth 503 convertido
indevidamente para 401; teste sem a fachada pública; import duplicado de
HttpProblem após reset de módulos no teste; filtro de testes ignorado;
cobertura sem aplicação do limite por arquivo; CTE modificador aninhado no
pgTAP; e o code incorreto `request.validation_failed` em vez do especificado
`validation.failed`. A ausência de logs estruturados de sucesso também foi
corrigida com campos permitidos e sink que não altera a resposta.

JOSE 6.2.18 foi conferido no npm. Coverage-v8 5.1.1 foi escolhido para combinar
com o Vitest já fixado e respeitar a quarentena de 24 h: a tag 5.1.2 tinha sido
publicada no mesmo dia. Nenhuma política de supply chain foi relaxada.

Não houve teste de ingestão de métricas na Vercel, assinatura EAS, aparelho ou
projeto Supabase hospedado. A conexão de dados do harness foi TLS direto no
Postgres local; o pooler segue com a prova da fundação W2. A v1 inteira do
template ainda depende das ondas 5–12.

## Limpeza

A confirmação final encontrou zero containers, volumes e redes desta verificação.
Os diretórios descartáveis, chaves de assinatura/TLS, senhas temporárias e túnel
SSH foram removidos; os demais workloads da KVM foram preservados.

## Próximo passo

Revisar/integrar esta branch na base de trabalho e executar a onda 5:
configuração remota e gates. Para este aceite local não falta conta ou segredo
do dono. Ao configurar um derivado real, os campos do servidor são APP_HOST,
SUPABASE_URL, DATABASE_URL, DATABASE_CA_CERT, UPSTASH_REDIS_REST_URL e
UPSTASH_REDIS_REST_TOKEN, todos sem valores no `.env.example`; preencher
`.env.local`/gerenciador do próprio projeto, nunca o chat.
