# ADR 0001 — Monorepo com pnpm workspaces e Turborepo

- **Status:** proposed
- **Data:** 2026-11-24

## Contexto

O template tem um app Expo, uma aplicação Next.js (API + site), contratos compartilhados
entre os dois, configuração do produto lida pelos dois e migrations do Supabase. Se cada
parte vivesse em um repositório ou pasta solta, nada garantiria que app e API concordam nos
formatos, e cada mudança de contrato viraria duas alterações coordenadas à mão.

O base-app também é o núcleo de versões derivadas (ADR 0013). A estrutura precisa ser estável
para que `git merge` do base-app continue funcionando.

## Decisão

Um repositório com pnpm workspaces e Turborepo:

- `apps/mobile` e `apps/web`;
- `packages/contracts` (Zod, OpenAPI gerado e client tipado), `packages/config`
  (`product.config.ts`) e `packages/tooling` (tsconfig, ESLint, dependency-cruiser);
- `supabase/` na raiz.

Regras:

- Turborepo orquestra `lint`, `typecheck`, `test` e `build`, com cache por pacote.
- Node e pnpm fixados (`.nvmrc` e `packageManager`).
- Lockfile commitado; `--frozen-lockfile` no CI.
- `apps/mobile` nunca importa `apps/web`; os dois compartilham código só por `packages/*`
  (regra `mobile-no-server` do dependency-cruiser).
- Política de instalação do pnpm em ADR 0012 (`allowBuilds`, `strictDepBuilds`,
  `minimumReleaseAge: 1440`).

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| Repositórios separados para app e API | Os contratos divergiriam; cada mudança de API seria duas PRs coordenadas |
| Nx | Mais recursos do que o template precisa; Turborepo é mais simples e integrado à Vercel |
| npm ou Yarn workspaces | pnpm é mais rápido e estrito contra dependências fantasmas |

## Consequências

- O Metro (bundler do React Native) precisa enxergar os pacotes do workspace. O Expo suporta
  monorepo, mas algumas bibliotecas nativas ainda pedem `node-linker=hoisted` no `.npmrc`. A
  onda 0 verifica e, se precisar, registra o motivo no próprio `.npmrc`.
- A Vercel faz build só de `apps/web` (Root Directory) e usa o filtro do Turborepo para pular o
  deploy quando a PR não toca `apps/web` nem `packages/*`.
- O EAS faz build só de `apps/mobile`, com o workspace instalado.
- Versões derivadas acrescentam pacotes e apps novos sem mover os existentes (ADR 0013).
