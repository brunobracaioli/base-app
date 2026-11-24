# ADR 0011 — Modelo B2C: o usuário é o próprio tenant

- **Status:** proposed
- **Data:** 2026-11-24

## Contexto

O método exige isolamento por tenant, com o tenant vindo da credencial e RLS como segunda
barreira. Apps de consumo não têm organizações: cada pessoa é dona dos próprios dados.

## Decisão

- O tenant é o usuário: `tenant_id` = `user_id` = `sub` do JWT verificado.
- Toda tabela com dado de usuário tem `user_id uuid` com FK para `auth.users(id) on delete
  cascade` e política RLS `user_id = (select auth.uid())`.
- Nenhum endpoint aceita `user_id` de body, query ou header. O `defineRoute` entrega só
  `auth.userId`.
- Cache, cotas, rate limits e chaves de idempotência são particionados por `user_id`.
- Teste obrigatório de acesso entre usuários em toda tabela (pgTAP) e em todo endpoint
  (integração).
- B2B (organizações, convites, papéis) está fora das duas versões do template.

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| Workspaces desde o início | Mais flexível, mas acrescenta convites, papéis e telas que um app de consumo não usa |

## Consequências

- Para virar B2B, o caminho é: schema `tenancy` com `workspaces` e `memberships`, coluna
  `workspace_id` nas tabelas de produto, claim de workspace ativo vinda de um custom access
  token hook do Supabase e políticas por membership. Exige novo ADR que substitua este.
- Extensões com dado de usuário seguem a mesma regra (`user_id` + RLS + teste entre usuários).
