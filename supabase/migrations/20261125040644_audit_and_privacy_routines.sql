create table audit.events (
  id             uuid primary key default gen_random_uuid(),
  occurred_at    timestamptz not null default now(),
  actor_type     text not null check (actor_type in ('user', 'system', 'webhook', 'operator')),
  actor_ref      text,
  subject_ref    text,
  action         text not null,
  resource_type  text not null,
  resource_ref   text,
  outcome        text not null check (outcome in ('success', 'denied', 'failed')),
  correlation_id text not null,
  metadata       jsonb not null default '{}',
  constraint actor_ref_format check (actor_ref is null or actor_ref ~
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|script:[a-z0-9:_-]{1,96}|[0-9a-f]{64})$'),
  constraint subject_ref_format check (subject_ref is null or subject_ref ~
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})$'),
  constraint resource_ref_no_uuid check (resource_ref is null or resource_ref !~*
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'),
  constraint action_format check (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  constraint metadata_size check (pg_column_size(metadata) <= 4096)
);
create index audit_events_occurred_idx on audit.events (occurred_at);
create index audit_events_subject_idx on audit.events (subject_ref, occurred_at desc);

alter table audit.events enable row level security;
alter table audit.events force row level security;
revoke all on audit.events from public, anon, authenticated;
grant insert on audit.events to authenticated, identity_system, privacy_system,
  app_config_system, platform_system, audit_writer, audit_operator_writer, ops;
grant select (id, occurred_at, actor_type, action, resource_type, resource_ref)
  on audit.events to ops;
grant select on audit.events to audit_reader;
grant delete on audit.events to ops;

create policy events_insert_user on audit.events for insert to authenticated
  with check (actor_type = 'user'
    and actor_ref = (select auth.uid())::text
    and (subject_ref is null or subject_ref = actor_ref));
create policy events_insert_system on audit.events for insert
  to identity_system, privacy_system, app_config_system, platform_system, ops
  with check (actor_type in ('system', 'webhook'));
create policy events_insert_writer on audit.events for insert to audit_writer
  with check (actor_type in ('system', 'webhook'));
create policy events_insert_operator on audit.events for insert to audit_operator_writer
  with check (actor_type = 'operator');
create policy events_select_ops on audit.events for select to ops using (true);
create policy events_select_reader on audit.events for select to audit_reader using (true);
create policy events_ops_delete on audit.events for delete to ops
  using (occurred_at < now() - interval '12 months');

create function audit.guard_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_user = 'ops'
     and current_setting('audit.mutation', true) = 'purge' then
    return old;
  end if;
  raise exception 'audit.events is append-only' using errcode = '42501';
end;
$$;
revoke all on function audit.guard_mutation() from public;
create trigger events_guard before update or delete on audit.events
  for each row execute function audit.guard_mutation();

-- Ops owns the only permitted audit mutations and runs them under forced RLS.
grant usage on schema platform to ops;
grant usage on schema app_config to ops;
grant select (user_id, key, expires_at), delete on platform.idempotency_keys to ops;
create policy idem_ops_expired_delete on platform.idempotency_keys for delete to ops
  using (expires_at < now());
grant select on app_config.operator_alert_exempt_keys to ops;

create function ops.purge_expired() returns void
language plpgsql security definer set search_path = '' as $$
declare
  c_batch      constant int := 5000;
  c_max_rounds constant int := 20;
  v_audit      bigint := 0;
  v_idem       bigint := 0;
  v_n          bigint;
  v_round      int;
begin
  perform set_config('audit.mutation', 'purge', true);
  for v_round in 1..c_max_rounds loop
    with doomed as (
      select e.id from audit.events e
      where e.occurred_at < clock_timestamp() - interval '12 months'
      order by e.occurred_at limit c_batch
    )
    delete from audit.events e using doomed d where e.id = d.id;
    get diagnostics v_n = row_count;
    v_audit := v_audit + v_n;
    exit when v_n < c_batch;
  end loop;
  perform set_config('audit.mutation', '', true);

  for v_round in 1..c_max_rounds loop
    with doomed as (
      select k.user_id, k.key from platform.idempotency_keys k
      where k.expires_at < clock_timestamp() limit c_batch
    )
    delete from platform.idempotency_keys k using doomed d
    where k.user_id = d.user_id and k.key = d.key;
    get diagnostics v_n = row_count;
    v_idem := v_idem + v_n;
    exit when v_n < c_batch;
  end loop;

  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('system', 'script:ops:purge_expired', 'ops.purge_expired', 'ops.cron', 'success',
          gen_random_uuid()::text,
          jsonb_build_object('audit_events_deleted', v_audit,
                             'idempotency_keys_deleted', v_idem));
end;
$$;
revoke all on function ops.purge_expired() from public, anon, authenticated,
  api_runtime, identity_system, privacy_system, app_config_system, platform_system;
grant execute on function ops.purge_expired() to postgres;

-- PostgreSQL 17 requires temporary ownership-transfer capabilities. Object
-- grants are configured first; the migration removes its own membership again.
grant create on schema ops to ops;
grant ops to postgres with set true, inherit false;
alter function ops.purge_expired() owner to ops;
revoke ops from postgres;
revoke create on schema ops from ops;
