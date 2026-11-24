# ADR 0003 — API como monolito modular em Next.js na Vercel

- **Status:** proposed
- **Data:** 2026-11-24

## Contexto

A API precisa verificar o JWT do Supabase, consultar o RevenueCat, orquestrar a exclusão de
conta, aplicar rate limit e cotas, e servir o site institucional (termos, privacidade e a
página de exclusão exigida pelo Google Play). A produção escolhida é Vercel + Supabase.

Um backend organizado por camada técnica (`routes/`, `utils/`, `models/`) tende a levar regra
de negócio para dentro das rotas e a misturar assuntos. O template precisa ensinar o
contrário.

## Decisão

1. **Uma aplicação Next.js (App Router)** em `apps/web` serve o site e a API em `/api/v1`. Os
   route handlers são adaptadores finos.
2. **Monolito modular por bounded context** em `apps/web/src/modules/<context>/`:
   - `domain/`: agregados, value objects, eventos, portas. Sem imports de fora.
   - `features/<slice>/`: um caso de uso por pasta, com `application/` (handler de command ou
     query), `presentation/` (`defineRoute` e mapeamento) e testes.
   - `infrastructure/`: adaptadores das portas (Kysely, RevenueCat, e-mail).
   - `index.ts`: única superfície pública do contexto.

   É uma adaptação da Vertical Slice Architecture para contextos em que vários casos de uso
   compartilham o mesmo agregado: o domínio fica no nível do contexto, a fatia fica no caso de
   uso.
3. Contextos do base-app: `identity`, `billing`, `privacy`, `app-config` e `examples`.
4. **`platform/`** guarda o que é transversal: pipeline HTTP (`defineRoute`), autenticação, rate
   limit, logger, acesso a banco, env, barramento de eventos, e-mail e `kernel` (Result, IDs,
   relógio).
5. **Comunicação entre contextos** só de duas formas: consulta ou comando pelo `index.ts` do
   outro contexto (grafo acíclico) ou evento de domínio declarado em `platform/events`. O
   barramento é em processo, síncrono e dentro da mesma transação; handlers são idempotentes.
6. **Fronteiras checadas no CI** com dependency-cruiser (regras na spec principal §3.5).
7. **Portas substituíveis e composição:** `EntitlementsReader`, `AccountDeletionPolicy`,
   `EmailSender` e `AuthorizationPolicies` podem ser trocadas por extensões (ADR 0013). A
   composição dos módulos do núcleo e das extensões fica em `composition/`.
8. **Rotas:** toda rota usa `defineRoute`, com `auth` obrigatório e sem valor padrão. A ordem
   fixa é gate de versão, autenticação, rate limit, autorização, validação, idempotência e caso
   de uso.

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| Supabase Edge Functions (Deno) como backend | Divide o código entre Deno e Node, sem o mesmo tooling de testes e fronteiras; a regra de negócio se espalha em funções soltas |
| Hono ou Fastify como serviço separado | API mais enxuta, mas exigiria outro projeto para o site. Fica como caminho de extração se a API crescer |
| Lógica no banco (SQL e RLS fazendo regra de negócio) | Difícil de testar e evoluir; o banco fica com integridade e isolamento, a regra fica no domínio |

## Consequências

- **Custo e abuso (G12):** Vercel, Upstash, Resend e Supabase cobram por uso. Uma regra de rate
  limit do Vercel Firewall em `/api` (300 req/min por IP) barra a inundação antes da função, e o
  `defineRoute` soma o teto por IP nas rotas autenticadas; os tetos de gasto e os alertas estão em
  base-app.md §3.13.
- **Cabeçalhos em três camadas (G13):** `next.config` (estáticos e CSP sem script), `defineRoute`
  (API) e middleware (CSP com nonce). A página que segura sessão se recusa a renderizar sem o
  nonce, e um Deployment Check confere os cabeçalhos antes da promoção.
- Funções serverless não guardam estado em memória entre requisições, além de caches (JWKS,
  configuração). Rate limit e cotas usam o Upstash Redis.
- Não há agendador em processo nem funções agendadas na Vercel: a manutenção roda no Postgres
  (ADR 0008).
- Extrair um contexto para serviço próprio exige trocar o barramento em processo por outbox +
  fila e as chamadas de `index.ts` por HTTP autenticado. As fronteiras já estão no lugar.
- Next.js como API traz peso que um framework só de API não teria; aceito pela simplicidade de
  um projeto Vercel só.
