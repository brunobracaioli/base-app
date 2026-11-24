# base-app — instruções para agentes de código

Template gratuito de app mobile (iOS + Android) com login por e-mail, assinatura pelo
RevenueCat, exclusão de conta, exportação de dados e atualização obrigatória. Vale para
qualquer agente de código (Codex, Claude Code) e para pessoas.

Se existir `AGENTS.bootstrap.md` na raiz, este repositório é uma versão derivada: leia também
aquele arquivo. Ele complementa este e prevalece em caso de conflito.

## Antes de qualquer tarefa

1. Leia `NOTES.md` (status atual e próxima onda).
2. Leia `docs/plan/implementation-waves.md` e faça **só** o escopo da onda em andamento.
3. Leia `docs/specs/base-app.md` (spec principal) e a spec da área que vai mexer.
4. Leia os ADRs citados pela spec em `docs/adr/`.

Código sem spec correspondente não entra. Se a spec estiver errada ou incompleta, pare,
descreva o problema e proponha a mudança na spec antes de codar.

## Stack

| Parte | Tecnologia |
|-------|------------|
| Monorepo | pnpm workspaces + Turborepo |
| App | React Native + Expo (Expo Router, EAS), TypeScript strict |
| API + site | Next.js (App Router) na Vercel, em `apps/web` |
| Auth | Supabase Auth; a API verifica o JWT por JWKS (`jose`) |
| Banco | Supabase Postgres; migrations SQL (Supabase CLI); Kysely; RLS; `pg_cron` |
| Cobrança | RevenueCat (SDK + paywall remoto + API REST) |
| Rate limit, cota, cache | Upstash Redis |
| E-mail | Resend (SMTP do Supabase Auth e API) |
| Validação | Zod (contratos em `packages/contracts`) |
| Observabilidade | pino (JSON), `@vercel/otel`, Sentry, `audit.events` |
| Testes | Vitest (API), Jest + RNTL (app), pgTAP (banco), Maestro (E2E) |

## Estrutura

Detalhes em `docs/specs/base-app.md` §3.3.

- `apps/web/src/modules/<contexto>/{domain,features/<slice>/{application,presentation},infrastructure,index.ts}`
- `apps/web/src/platform/`: pipeline HTTP, auth, db, env, logger, eventos, e-mail, kernel
- `apps/web/src/extensions/{index.ts,edge.ts,site.tsx}` e `apps/mobile/src/extensions/index.ts`:
  pontos de extensão (vazios aqui)
- `apps/mobile/src/features/<feature>/{model,api,adapters,ui}`; rotas em
  `apps/mobile/src/app/` sem lógica
- `packages/contracts`, `packages/config`, `packages/tooling`
- `supabase/{config.base.toml,config.d,config.toml,migrations,tests,templates}`; o `config.toml`
  é gerado por `pnpm supabase:config` e nunca editado à mão

## Regras deste repositório

**Arquitetura**

- Monolito modular com Vertical Slice Architecture e DDD. Rotas são finas: validar → chamar o
  caso de uso → responder. Regra de negócio mora no domínio, nunca na rota.
- Dependências apontam para dentro: `presentation` → `application` → `domain`.
  `infrastructure` implementa portas declaradas em `domain`. `domain` não importa nada de fora.
- Um contexto só importa outro pelo `index.ts`. Eventos entre contextos ficam em
  `platform/events`. O dependency-cruiser barra o resto.
- Cada contexto usa só o próprio papel de sistema (`systemDb('<contexto>')`).

**Segurança**

- Toda rota usa `defineRoute` com `auth` explícito. Rota pública só se estiver no contrato
  com `security: []`.
- Ordem fixa: gate de versão e manutenção → autenticação → rate limit → autorização →
  validação → caso de uso.
- `user_id` vem só do JWT verificado. Nunca de body, query ou header.
- Input validado com Zod em toda fronteira (body, query, headers, respostas de terceiros).
  Schemas de body são `.strict()`; a única exceção é `.strip()` em payloads de emissor
  autenticado (webhooks e hooks de terceiros), em `packages/contracts/src/**/webhooks/**`.
- SQL: claims vão ao Postgres por `set_config(..., $1, true)` com bind. Nunca `SET` de sessão,
  nunca SQL interpolado (Semgrep barra).
- Nenhum segredo no código nem no app. Segredos só em variáveis de ambiente validadas por
  `platform/env`. O app só carrega chaves públicas por desenho.
- Sem `console.*`. Logger com redaction; nada de e-mail, token ou nome em log. Usuário
  aparece só pelo UUID.
- Erros em `problem+json` com `code` estável; nunca stack trace, erro do banco ou dica de
  autenticação.
- Toda chamada de saída tem timeout; retry com backoff só em operação idempotente.
- Todo `defineRoute` declara `rateLimit` com `onStoreFailure` (e `ipLimit` quando autenticada).
  `purgeAccount` só com `PurgeAuthorization` e só em `modules/privacy/**` e `extensions/**`.
  Gravação em `audit.events` só por `recordAuditEvent`. Funções `SECURITY DEFINER` que tocam
  `auth` pertencem ao `auth_fn_owner`.

**Contratos e banco**

- Contratos primeiro: mudança de API começa em `packages/contracts`; rode
  `pnpm contracts:openapi` e commite o YAML gerado.
- `POST` com efeito colateral não natural exige `Idempotency-Key`; o pipeline devolve a
  resposta guardada em replay e o caso de uso nunca roda duas vezes.
- Toda tabela nova = migration + RLS forçado + grants por papel + pgTAP (inclusive acesso
  entre usuários) + `pnpm db:types` + handler de `AccountPurgeRequested`.
- Migration aplicada é imutável. Erro? Nova migration que corrige.

**App**

- Uma tela por fluxo (nada de cópia por plataforma).
- Textos só em `shared/i18n/locales/<idioma>/<namespace>.json`, nos três idiomas.
- Nenhuma rota do Expo Router executa ação ao montar; parâmetros validados com Zod.

**Configuração e extensão**

- Nome, IDs e métodos de login do produto só em `packages/config/src/product.config.ts`.
- Novos pontos de extensão são genéricos e documentados em `docs/specs/base-app.md` §3.4.
  O núcleo precisa funcionar com as listas de extensão vazias.

## Testes

- Pirâmide: muito unit, médio integração, pouco E2E.
- `domain/` e `application/` com cobertura ≥ 80%; falha de cobertura quebra o build.
- Testes determinísticos: relógio e gerador de ID injetados, sem `sleep`, sem rede externa
  (RevenueCat e Resend por fakes nas portas), seed fixa.
- Bug fix começa com um teste que reproduz o bug.
- Os critérios de aceite da spec viram testes.

## Fluxo de trabalho

- Uma onda do plano por vez, numa branch `feat/wave-<n>-<slug>` (ou `docs/`, `chore/`).
- Antes de dar uma onda como pronta: rode os gates da onda (lint, typecheck, testes, pgTAP,
  dependency-cruiser, drift de contrato e de tipos) e confira cada critério de aceite.
- Atualize `NOTES.md` (status e próxima onda) ao fim de cada onda.
- Commits atômicos em Conventional Commits, em inglês (`feat(auth): ...`).
- Não faça push, não abra PR e não publique nada sem pedido explícito.

## Idioma

Documentação em pt-BR. Código, identificadores, comentários e mensagens de commit em inglês.
Textos do app via i18n.

## Comandos

Definidos na onda 0. Previstos:

```bash
pnpm install
pnpm turbo run lint typecheck test
pnpm contracts:openapi          # gera docs/reference/openapi.yaml
supabase start && supabase db reset && supabase test db
pnpm db:types                   # tipos Kysely do banco local
pnpm --filter web dev
pnpm --filter mobile start
```
