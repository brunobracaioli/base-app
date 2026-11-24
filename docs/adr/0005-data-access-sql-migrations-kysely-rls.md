# ADR 0005 — Acesso a dados: migrations SQL, Kysely, RLS e Data API fechada

- **Status:** proposed
- **Data:** 2026-11-24

## Contexto

O Supabase oferece a Data API (PostgREST), que deixa o app ler e escrever tabelas direto, com
RLS. É rápido para um MVP, mas espalha regra de negócio entre políticas SQL e app, e abre ao
app toda a superfície de tabelas. O método pede regra no domínio, filtro por tenant no
repositório e RLS como segunda barreira.

## Decisão

1. **Schema como código.** Migrations SQL em `supabase/migrations/`, aplicadas pelo Supabase
   CLI. Migration aplicada é imutável: erro se corrige com migration nova.
2. **Um schema Postgres por contexto que tem tabelas:** `identity`, `privacy`, `app_config`.
   Mais `platform` (chaves de idempotência), `audit` e `ops`. O contexto `billing` não tem
   tabelas no base-app (ADR 0006). `public` fica vazio e sem grants para `anon` e
   `authenticated`. O app não acessa tabelas.
3. **Data API (PostgREST) e `pg_graphql` desligados** no projeto, em `config.toml`.
4. **A API acessa o banco com Kysely** sobre `pg`, pelo pooler do Supabase em modo transação,
   com o pool ligado ao ciclo da função (`attachDatabasePool` do `@vercel/functions`). Tipos
   gerados por `kysely-codegen` contra o banco local, com verificação de drift no CI.
5. **TLS verificado.** `ssl: { ca, rejectUnauthorized: true }` com a CA do Supabase e SSL
   obrigatório no projeto. Nunca `rejectUnauthorized: false`.
6. **Usuário de login `api_runtime` sem nenhum grant de tabela.** Ele só pode assumir os papéis
   abaixo, não é dono das tabelas e por isso não ignora RLS. Fora de uma transação com papel
   definido, toda query falha.
7. **Dois modos de acesso, ambos em transação:**
   - `userScopedDb(claims)`: executa
     `select set_config('role', 'authenticated', true), set_config('request.jwt.claims', $1, true)`
     com **bind parameter**, nunca interpolação. As claims enviadas são só `sub`, `role`, `aal`
     e `session_id`; nunca `user_metadata`, que o usuário edita. As políticas RLS usam
     `(select auth.uid())`. Todo caso de uso iniciado pelo usuário usa este modo, e o
     repositório **também** filtra por `user_id` (primeira barreira; RLS é a segunda).
   - `systemDb(<contexto>)`: papel de sistema **do contexto**, sem login e sem `BYPASSRLS`, com
     grants só no próprio schema, listados na migration de papéis:

     | Papel | Schema com grants |
     |-------|-------------------|
     | `identity_system` | `identity` |
     | `privacy_system` | `privacy` |
     | `app_config_system` | `app_config` |
     | `platform_system` | `platform` |
     | `ops` | só o necessário para `ops.purge_expired()` apagar `audit.events` vencidos e `platform.idempotency_keys` vencidas; sem login e fora do alcance de `api_runtime` |

     `systemDb('<contexto>')` só é importável pela infraestrutura do próprio contexto (regra
     `system-db-per-context`). Handlers de eventos que rodam na transação de outro contexto
     trocam para o papel do próprio contexto com `set_config('role', ..., true)` e voltam ao
     terminar.
8. **Proibido `SET` de sessão** (sem `local`) e `set_config(..., false)`: vazariam papel e
   claims para o próximo cliente do pooler. **Regra Semgrep** no CI barra os dois e também SQL
   cru interpolado (`sql.raw`, `sql.lit`).
9. **Invariantes críticas também no banco.** `audit.events` só recebe `insert` (ninguém tem
   `update` nem `delete`, exceto a função de expurgo); a separação de papéis é lógica, e uma
   injeção de SQL ou execução de código na API ainda poderia trocar de papel. O expurgo é feito
   por `ops.purge_expired()` (`SECURITY DEFINER`), agendada no `pg_cron` (ADR 0008). A trava de
   `audit.events` confere `current_user = 'ops'`, além do GUC.
   **Funções `SECURITY DEFINER` que tocam `auth`** (`privacy.lookup_email_for_purge`,
   `privacy.is_anonymous_user`, `privacy.delete_auth_user`, `identity.clear_unverified_password`,
   `identity.before_user_created`, `ops.purge_unconfirmed_users`) pertencem ao papel `auth_fn_owner`
   (NOLOGIN, com um conjunto fixo de grants em `auth` (base-app §3.8), nunca `postgres`), têm `search_path = ''` e as de
   purga só operam sobre o usuário em `app.purge_user_id`. Isso reduz erro de código; não impede
   injeção de SQL (R11).
10. **RLS habilitado e forçado** (`force row level security`) em toda tabela, com teste pgTAP por
    política, incluindo acesso de um usuário à linha de outro.
11. **As extensões nunca alteram tabelas do núcleo.** Uma extensão cria schema, papel
    `<extensão>_system` e tabelas próprias; para dado extra sobre o usuário, cria uma tabela 1:1
    com FK para `auth.users` (ADR 0013). O teste de purga completa varre o catálogo e cobre as
    tabelas novas sem configuração.

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| `supabase-js` (PostgREST) na API | Exigiria expor os schemas na Data API, o que também os expõe ao app |
| Drizzle com migrations geradas | RLS, grants e funções ficam menos naturais no gerador; SQL puro com tipos gerados é mais previsível |
| Prisma | Pesado em serverless e pouco à vontade com RLS por transação |
| Um papel de sistema único | Um contexto comprometido alcançaria todos os schemas |

## Consequências

- **Teste de catálogo (G26):** o pgTAP falha para qualquer tabela fora dos schemas de sistema
  sem RLS habilitado e forçado, com grant para `anon`/`public`, ou com grant de `authenticated`
  fora de `supabase/tests/grants-allowlist.json`. `anon` e `authenticated` não têm privilégio em
  `storage` nem `realtime` (desligados; revogados por migration).
- Os papéis-grupo `audit_writer`, `audit_operator_writer`, `audit_reader` e `app_config_writer` têm os membros conferidos
  por pgTAP contra `supabase/tests/expected-group-members.json`.
- Toda tabela nova exige migration, RLS forçado, grants por papel, pgTAP (inclusive acesso
  entre usuários), tipos regenerados e handler de purga em `AccountPurgeRequested`.
- Realtime ou Storage do Supabase direto no app exigem ADR próprio, expondo só o necessário com
  RLS.
- Cada papel novo de uma extensão precisa de teste pgTAP de que não tem grants fora do próprio
  schema.
- **Spike S-DB-1 (onda 2):** confirmar `set_config` com bind e a troca de papel através do
  pooler em modo transação com o usuário `api_runtime`.
