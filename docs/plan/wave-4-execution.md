# Onda 4 — Auth na API, perfil e consentimentos

## Base e escopo

A `main` local foi atualizada por fast-forward para `4261bce`, fundações verificadas
em `d941c41` mais documentação de fechamento. A referência remota ainda está em
`cda886d`; nenhum push foi feito. A branch desta onda é
`feat/w4-auth-profile-consents`, em `/tmp/app-base-w4`, criada com árvore limpa.

Executar somente a onda 4. S-TM-3 vem antes do código de produção. Login mobile,
endpoints/configuração remota da onda 5, cobrança e purga completa da onda 9
continuam fora do escopo. O leitor mínimo de versões legais atende à porta já
prevista por privacy; não antecipa `/v1/app-config` nem seu cache/gates.

## Arquivos e provas previstas

| Área | Arquivos a criar/estender | Teste de aceite |
| --- | --- | --- |
| Spike S-TM-3 | `supabase/tools/w4-auth-spike.mjs`, ADR 0004 | GoTrue real com JWT assimétrico, JWKS público, roles/providers/is_anonymous/amr e propagação após refresh |
| Contratos | `packages/contracts/src/identity.ts`, `privacy.ts`, catálogo/gerador OpenAPI | Bodies estritos, perfil completo, consentimento 204 sem body, erro 409 e metadata de limite |
| Pipeline/Auth | `apps/web/src/platform/auth/**`, tipos HTTP, composição e env | Alg/iss/aud/exp/iat/UUIDs, tamanho, cache/cooldown, timeout, conta excluída, mesmo resultado via função pública e pipeline |
| Perfil | `apps/web/src/modules/identity/**`, rotas `/api/v1/me` | Criação única concorrente, locale permitido, normalização de nome, PATCH desconhecido → 400, A não acessa B |
| Consentimentos | `apps/web/src/modules/privacy/**`, rota `/api/v1/me/consents` | Versão atual → 204, repetição sem duplicar, versão antiga → 409, estado de aceites e isolamento A/B |
| Leitor legal mínimo | `modules/app-config/infrastructure/**`, interface pública e composição | Lê as versões existentes em `app_config.settings` usando o papel do contexto e sem importar internals de privacy |
| Banco | Nova migration imutável, pgTAP W4, registry Auth, tipos gerados | Grants/RLS forçado, UPDATE por coluna, FK/cascata, funções registradas e chamadas negadas entre usuários |
| Purga por contexto | Handlers de `AccountPurgeRequested` | Cada handler apaga somente as linhas do usuário com o papel do próprio contexto; sem antecipar o fluxo W9 |
| Observabilidade/gates | Testes de redaction, métricas sem PII, Vitest/arquitetura | Falha não expõe token/email/metadata; cobertura domain/application ≥80%; drift e scans verdes |

A implementação será dividida entre contratos/pipeline, verificação Auth e
módulos/banco, com ownership explícito por arquivo. Lockfile e integração ficam
com o gerente. Coders usam Luna/xhigh; revisões e testes podem executar em paralelo.

## Definições aprovadas em 2026-11-25

O dono aprovou explicitamente as três definições abaixo. Elas fecham as
lacunas identificadas antes da implementação, preservando as demais regras
das specs e os limites operacionais do template.

1. **Falhas de Redis:** GET/PATCH `/v1/me` e POST `/v1/me/consents` usam
   `onStoreFailure: 'closed'`, mantendo os limites por usuário já especificados e
   o teto geral de 120/min por IP. A falha ao consultar o marcador de conta
   excluída também falha fechada: `503 auth.unavailable`, com Retry-After. A
   política pública já aprovada de `/v1/health` permanece fora deste escopo.
   Fontes: identity-and-auth §§3.5/5 e base-app §3.6.
2. **Papéis frescos:** registrar `identity.read_fresh_roles(uuid)` como função
   pequena do núcleo, dona `postgres`, `SECURITY DEFINER`, SQL fixo e
   `search_path = ''`. EXECUTE somente para `authenticated`; UUID obrigatório
   igual a `auth.uid()`. Retorna somente `raw_app_meta_data.roles` para o usuário
   da transação. Não concede SELECT em Auth nem usa chave administrativa na API.
   Valores ausentes/inválidos viram `[]`; falhas de leitura negam autorização
   pelo comportamento existente do pipeline. Testar UUID nulo/diferente,
   chamadores não permitidos e nenhum retorno de dados de outro usuário.
   Fontes: base-app §§3.4.2/3.6/3.8 e ADR 0016.
3. **Data do perfil:** `Me.createdAt` representa `identity.profiles.created_at`,
   criado na primeira chamada ao perfil. Não representa a data de criação da
   conta Auth. Isso mantém a fonte de dados já descrita sem acrescentar leitura
   de outro campo de Auth. Fonte: identity-and-auth §§4/5.

## Interpretações que preservam o contrato

- `kid` que continua desconhecido é token não verificável: `auth.invalid_token`.
- `iat` futuro além da tolerância de 30 s é inválido; os testes de token expirado
  devem ultrapassar a mesma tolerância, em vez de contradizer a janela já prevista.
- A sugestão de locale é validada pela allowlist e mantida privadamente pelo
  verificador; `user_metadata` não passa para AuthContext nem para dbClaims.
- Consentimento desatualizado e repetido já têm comportamento definido; entram
  explicitamente nos testes de endpoint, sem mudar os códigos da spec.
- Métricas de resultado/duração usam rótulos finitos, sem dados pessoais nem
  habilitação de serviço/conta externa. O runtime local continua sem envio.

## Verificação e limites operacionais

Executar os gates locais de código, build e drift; `supabase test db` e geração
real de tipos na KVM isolada; integração com JWT real e mesma função pública de
verificação. Cobertura de domain/application não pode ser só documentação.

A KVM existente é usada em namespace próprio, portas em loopback e credenciais
transitórias fora do código/log. Nenhum projeto hospedado, conta real, deploy,
GitHub Actions, push ou PR faz parte desta onda. O relatório final deve separar
fakes, provas reais locais e configurações futuras do derivado.

## Coordenação da implementação

- Contratos/pipeline: `packages/contracts/**`, OpenAPI, `platform/http` (exceto
  `runtime.ts` e novo `core-routes.ts`), fakes HTTP e runner/cobertura Vitest.
- Auth: `platform/auth/**`, `platform/authorization/types.ts`, env, `.env.example`
  e `platform/http/runtime.ts`. Tipos compartilhados publicados primeiro.
- Módulos: `modules/identity`, `modules/privacy`, leitor mínimo de `modules/app-config`,
  rotas finas, nova composição de casos de uso e `platform/http/core-routes.ts`.
- Banco: migration W4, pgTAP, registry Auth e ajustes estritos das guardas de banco.
  O gerente aplica somente na stack descartável e regenera os tipos reais.

Protocolo entre os workers: `AuthVerificationResult` em `platform/auth/types.ts`
usa `{ ok: true, value: UserAuthContext }` ou `{ ok: false, error: AuthFailure }`.
O contexto de usuário amplia o atual com `sessionId`, `aal`, `email`,
`amr.method` e `dbClaims`, mantendo `kind: 'user'`. `authenticateUser` devolve
esse resultado; o pipeline preserva o code e o 401/503. `loadFreshRoles` recebe
o contexto verificado completo, para não perder as claims usadas na transação.
A sugestão de locale usa um accessor privado, não um campo de metadata público.

Módulos expõem factories e interfaces públicas; a composição injeta repositórios
e leitores. Não abrir transações aninhadas entre perfil, consulta legal e
consentimentos. Handlers de purga recebem a transação fornecida e não antecipam
a orquestração/endpoint da onda 9. A montagem HTTP precisa ser lazy para que
build/health continuem funcionando sem credenciais de produto.

A primeira alteração de produção será o contrato. Os demais coders aguardam o
commit dos contratos, depois trabalham em paralelo com ownership separado.

## Dependências verificadas

Registro npm consultado em 2026-11-25: `jose` estável 6.2.18 (publicado em
2026-11-18). `@vitest/coverage-v8` 5.1.1 é a versão estável compatível com o
Vitest já fixado e elegível pela quarentena; foi publicada em 2026-11-18.
A 5.1.2 é a tag latest, publicada em 2026-11-25, ainda dentro dos 1440 minutos
bloqueados. Manter o par 5.1.1 preserva a política de supply chain sem afrouxá-la.
Versões exatas e lockfile ficam com o gerente; nenhum worker instala dependências.

## Fechamento

Onda concluída localmente. A [matriz final](wave-4-verification.md) registra os
comandos, o alcance dos fakes e as provas reais. Nenhuma decisão permanece
pendente nesta onda; as etapas do app derivado continuam separadas.
