-- Base application roles. The runtime login deliberately has no table grants;
-- it may only SET LOCAL one explicitly granted execution role inside a
-- transaction. Provision its password out of band after applying migrations.
do $$
declare
  v_has_legacy_alert_secret boolean := false;
begin
  if current_user <> 'postgres' then
    raise exception 'W2 baseline must be applied through the Supabase CLI postgres connection.'
      using errcode = '42501';
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'api_runtime')
     or exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net') then
    raise exception 'W2 baseline requires a fresh template database; legacy app roles or pg_net exist. Do not apply over an existing project. Inspect queues, webhooks, and credentials, then use a separately reviewed migration.'
      using errcode = '55000';
  end if;

  if pg_catalog.to_regclass('vault.secrets') is not null then
    begin
      execute 'select exists (select 1 from vault.secrets where name in (' ||
        quote_literal('ALERT_RESEND_API_KEY') || ', ' ||
        quote_literal('ALERT_TO') || ', ' || quote_literal('ALERT_FROM') || '))'
        into v_has_legacy_alert_secret;
    exception when others then
      raise exception 'W2 baseline cannot verify legacy alert secrets in Vault; inspect the existing project and use a separately reviewed migration.'
        using errcode = '55000';
    end;
    if v_has_legacy_alert_secret then
      raise exception 'W2 baseline found legacy alert secrets in Vault; inspect queued requests, rotate exposed credentials, and use a separately reviewed migration.'
        using errcode = '55000';
    end if;
  end if;
end;
$$;

create role api_runtime login noinherit;
create role migrator nologin;
create role identity_system nologin;
create role privacy_system nologin;
create role app_config_system nologin;
create role platform_system nologin;
create role ops nologin;
create role app_config_admin nologin;
create role audit_writer nologin;
create role audit_operator_writer nologin;
create role audit_reader nologin;
create role app_config_writer nologin;

grant authenticated, identity_system, privacy_system, app_config_system, platform_system
  to api_runtime with set true, inherit false;

-- The detailed privacy spec explicitly authorizes these core roles to insert
-- events. These are direct role grants, not membership in audit_writer.
grant audit_writer, audit_operator_writer to app_config_admin;

create schema identity;
create schema privacy;
create schema app_config;
create schema platform;
create schema audit;
create schema ops;
create schema if not exists extensions;

revoke all on schema public from public, anon, authenticated, api_runtime;
revoke create on schema public from public, anon, authenticated;
revoke all on schema identity, privacy, app_config, platform, audit, ops
  from public, anon, authenticated, api_runtime;

grant usage on schema identity to authenticated, identity_system;
grant usage on schema privacy to authenticated, privacy_system;
grant usage on schema app_config to app_config_system, app_config_admin, app_config_writer;
grant usage on schema platform to platform_system;
grant usage on schema audit to authenticated, identity_system, privacy_system,
  app_config_system, platform_system, audit_writer, audit_operator_writer,
  audit_reader, ops;
grant usage on schema ops to ops;
grant usage, create on schema identity, privacy, app_config, platform, audit, ops
  to migrator;
grant usage on schema identity to ops;

-- This private quota table stores no account, e-mail, or network identifiers.
create table identity.signup_reservations (
  reservation_id uuid primary key default gen_random_uuid(),
  reserved_at timestamptz not null default clock_timestamp()
);
alter table identity.signup_reservations enable row level security;
alter table identity.signup_reservations force row level security;
revoke all on identity.signup_reservations
  from public, anon, authenticated, service_role, api_runtime, ops;
create policy signup_reservations_postgres_all
  on identity.signup_reservations for all to postgres
  using (true) with check (true);

-- api_runtime can activate a role but does not inherit its table privileges.
-- Extension migrations must use the same SET-only membership contract for
-- each boot-validated extension system role.
-- Idempotency keys are scoped by the authenticated user. The API only reaches
-- them through platform_system transactions; the cleanup function is owned by
-- ops in the following migration.
create table platform.idempotency_keys (
  user_id         uuid not null references auth.users(id) on delete cascade,
  key             uuid not null,
  request_hash    text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  state           text not null check (state in ('in_progress', 'completed')),
  locked_until    timestamptz not null,
  response_status smallint,
  response_body   jsonb check (response_body is null or pg_column_size(response_body) <= 65536),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '24 hours',
  primary key (user_id, key),
  constraint idempotency_response_state check (
    (state = 'in_progress' and response_status is null and response_body is null)
    or
    (state = 'completed' and response_status between 200 and 299 and response_body is not null)
  )
);
create index idempotency_keys_expires_idx on platform.idempotency_keys (expires_at);
alter table platform.idempotency_keys enable row level security;
alter table platform.idempotency_keys force row level security;
revoke all on platform.idempotency_keys from public, anon, authenticated;
grant select, insert, update, delete on platform.idempotency_keys to platform_system;
create policy idem_system_all on platform.idempotency_keys for all to platform_system
  using (true) with check (true);

-- Remote configuration is deliberately written only by app_config.set_setting.
create function app_config.semver_key(p_version text) returns int[]
language sql immutable parallel safe set search_path = '' as $$
  select string_to_array(p_version, '.')::int[]
$$;

create function app_config.valid_versions(p_value jsonb) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select coalesce(bool_and(coalesce(
    (p_value -> p ->> 'minSupported') ~ '^\d+\.\d+\.\d+$'
    and (p_value -> p ->> 'latest') ~ '^\d+\.\d+\.\d+$'
    and app_config.semver_key(p_value -> p ->> 'minSupported')
      <= app_config.semver_key(p_value -> p ->> 'latest')
    and ((p_value -> p ->> 'published') is null
      or (p_value -> p ->> 'published') ~ '^\d+\.\d+\.\d+$')
  , false)), false)
  from unnest(array['ios', 'android']) as p
$$;

create table app_config.settings (
  key        text primary key check (key in ('versions', 'maintenance', 'legal')),
  value      jsonb not null check (jsonb_typeof(value) = 'object' and pg_column_size(value) <= 2048),
  updated_at timestamptz not null default now(),
  constraint settings_value_shape check (
    coalesce(case key
      when 'versions' then app_config.valid_versions(value)
      when 'maintenance' then jsonb_typeof(value -> 'active') = 'boolean'
        and (value -> 'messageKey' is null
          or (value ->> 'messageKey') ~ '^maintenance\.[a-z0-9_]{1,60}$')
      when 'legal' then (value ->> 'termsVersion') ~ '^\d{4}-\d{2}-\d{2}$'
        and (value ->> 'privacyVersion') ~ '^\d{4}-\d{2}-\d{2}$'
    end, false)
  )
);

alter table app_config.settings enable row level security;
alter table app_config.settings force row level security;
revoke all on app_config.settings from public, anon, authenticated;
grant select on app_config.settings to app_config_system;
grant select, insert, update on app_config.settings to app_config_admin;
create policy settings_system_select on app_config.settings for select to app_config_system
  using (true);
create policy settings_admin_select on app_config.settings for select to app_config_admin
  using (true);
create policy settings_admin_insert on app_config.settings for insert to app_config_admin
  with check (true);
create policy settings_admin_update on app_config.settings for update to app_config_admin
  using (true) with check (true);

insert into app_config.settings (key, value) values
  ('versions',    '{"ios":{"minSupported":"1.0.0","latest":"1.0.0"},"android":{"minSupported":"1.0.0","latest":"1.0.0"}}'),
  ('maintenance', '{"active":false}'),
  ('legal',       '{"termsVersion":"2026-01-01","privacyVersion":"2026-01-01"}');

create function app_config.set_setting(
  p_key text, p_value jsonb, p_actor_type text, p_actor_ref text,
  p_correlation_id text, p_expected_updated_at timestamptz
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
  v_updated_at timestamptz;
  c_max_changes_per_hour constant int := 20;
begin
  if p_key is null or p_key not in ('versions', 'maintenance', 'legal') then
    raise exception 'unknown app_config key' using errcode = '22023';
  end if;
  if p_actor_type is null or p_actor_type not in ('system', 'operator') then
    raise exception 'invalid actor type' using errcode = '22023';
  end if;
  if p_actor_type = 'system' and (
    p_actor_ref is null or p_actor_ref !~ '^script:app-config:[A-Za-z0-9_-]{1,64}$'
  ) then
    raise exception 'invalid system actor' using errcode = '22023';
  end if;
  if p_actor_type = 'operator' and (
    p_actor_ref is null
    or p_actor_ref !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_actor_ref is distinct from current_setting('app.operator_id', true)
  ) then
    raise exception 'operator does not match transaction context' using errcode = '42501';
  end if;

  -- Serialize same-key writes so a missing row cannot defeat the optimistic
  -- token when two writers race to create it.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'app_config requires read committed isolation' using errcode = '25001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('base-app-config:' || p_key, 0));
  perform pg_advisory_xact_lock(hashtextextended('base-app-config-hourly-limit', 0));
  if ops.app_config_change_count_last_hour() >= c_max_changes_per_hour then
    raise exception 'too many app_config changes' using errcode = '54000';
  end if;

  select s.value, s.updated_at into v_before, v_updated_at
    from app_config.settings s where s.key = p_key;
  if v_updated_at is distinct from p_expected_updated_at then
    raise exception 'app_config conflict' using errcode = 'AC409';
  end if;

  insert into app_config.settings (key, value, updated_at)
  values (p_key, p_value, clock_timestamp())
  on conflict (key) do update
    set value = excluded.value, updated_at = excluded.updated_at;

  insert into audit.events (actor_type, actor_ref, action, resource_type, resource_ref,
                            outcome, correlation_id, metadata)
  values (p_actor_type, p_actor_ref, 'app_config.updated', 'app_config.settings', p_key,
          'success', p_correlation_id,
          jsonb_build_object('before', v_before, 'after', p_value));
end;
$$;
revoke all on function app_config.set_setting(text, jsonb, text, text, text, timestamptz)
  from public, anon, authenticated, service_role, api_runtime, identity_system,
       privacy_system, app_config_system, platform_system, ops;
grant execute on function app_config.set_setting(text, jsonb, text, text, text, timestamptz)
  to app_config_writer, app_config_admin;

-- PostgreSQL 17 requires temporary ownership-transfer capabilities. Object
-- grants are configured first; the migration removes its own membership again.
grant create on schema app_config to app_config_admin;
grant app_config_admin to postgres with set true, inherit false;
alter function app_config.set_setting(text, jsonb, text, text, text, timestamptz) owner to app_config_admin;
revoke app_config_admin from postgres;
revoke create on schema app_config from app_config_admin;

create table app_config.operator_alert_exempt_keys (
  key text primary key check (key in ('versions', 'maintenance', 'legal'))
);
alter table app_config.operator_alert_exempt_keys enable row level security;
alter table app_config.operator_alert_exempt_keys force row level security;
revoke all on app_config.operator_alert_exempt_keys from public, anon, authenticated;
grant select on app_config.operator_alert_exempt_keys to ops, app_config_system;
create policy operator_alert_exempt_keys_system_select
  on app_config.operator_alert_exempt_keys for select to app_config_system using (true);
create policy operator_alert_exempt_keys_ops_select
  on app_config.operator_alert_exempt_keys for select to ops using (true);
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

create function ops.app_config_change_count_last_hour() returns bigint
language sql volatile security definer set search_path = '' as $$
  select count(*)
  from audit.events e
  where e.action = 'app_config.updated'
    and e.occurred_at > clock_timestamp() - interval '1 hour'
$$;
revoke all on function ops.app_config_change_count_last_hour()
  from public, anon, authenticated, service_role, api_runtime, identity_system,
       privacy_system, app_config_system, platform_system, app_config_writer;
grant usage on schema ops to app_config_admin;
grant execute on function ops.app_config_change_count_last_hour() to app_config_admin;

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
create function identity.before_user_created(event jsonb) returns jsonb
language plpgsql security definer set search_path = ''
set lock_timeout = '1500ms'
set statement_timeout = '1750ms'
as $$
declare
  c_cap constant bigint := 300;
  v_now timestamptz;
  v_reservation_count bigint;
begin
  if event is null
     or jsonb_typeof(event) is distinct from 'object'
     or jsonb_typeof(event -> 'user') is distinct from 'object' then
    return jsonb_build_object('error', jsonb_build_object(
      'message', 'invalid signup event', 'http_code', 400));
  end if;

  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'signup quota requires read committed isolation' using errcode = '25001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('base-app-signup-hourly-limit', 0));
  v_now := clock_timestamp();

  delete from identity.signup_reservations r
  where r.reserved_at <= v_now - interval '1 hour';

  select count(*) into v_reservation_count
  from identity.signup_reservations r
  where r.reserved_at > v_now - interval '1 hour';

  if v_reservation_count >= c_cap then
    return jsonb_build_object('error', jsonb_build_object(
      'message', 'signups temporarily limited', 'http_code', 429));
  end if;

  insert into identity.signup_reservations (reserved_at) values (v_now);
  return '{}'::jsonb;
end;
$$;
comment on function identity.before_user_created(jsonb) is
  'Atomically reserves one anonymous signup slot; accepts user objects without email.';
revoke all on function identity.before_user_created(jsonb)
  from public, anon, authenticated, service_role, api_runtime, identity_system,
       privacy_system, app_config_system, platform_system, ops, app_config_admin,
       app_config_writer;
grant usage on schema identity to supabase_auth_admin;
grant execute on function identity.before_user_created(jsonb) to supabase_auth_admin;

create function identity.count_unconfirmed_users() returns bigint
language sql security definer set search_path = '' as $$
  select count(*)
  from auth.users u
  where nullif(pg_catalog.btrim(u.email), '') is not null
    and u.email_confirmed_at is null
    and not coalesce(u.is_anonymous, false)
$$;
revoke all on function identity.count_unconfirmed_users()
  from public, anon, authenticated, service_role, api_runtime, identity_system,
       privacy_system, app_config_system, platform_system, app_config_admin,
       app_config_writer;
grant execute on function identity.count_unconfirmed_users() to ops;

create function identity.delete_unconfirmed_users() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_deleted integer;
begin
  with doomed as (
    select u.id
    from auth.users u
    where nullif(pg_catalog.btrim(u.email), '') is not null
      and u.email_confirmed_at is null
      and not coalesce(u.is_anonymous, false)
      and u.created_at < clock_timestamp() - interval '3 days'
    order by u.created_at, u.id
    limit 500
    for update skip locked
  )
  delete from auth.users u using doomed d where u.id = d.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke all on function identity.delete_unconfirmed_users()
  from public, anon, authenticated, service_role, api_runtime, identity_system,
       privacy_system, app_config_system, platform_system, app_config_admin,
       app_config_writer;
grant execute on function identity.delete_unconfirmed_users() to ops;

-- Supabase Cron is the only extension required by this baseline.
create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to ops;
grant select (status, start_time) on cron.job_run_details to ops;

grant select (user_id, key, expires_at), delete on platform.idempotency_keys to ops;

create table ops.alerts (
  code text primary key check (code in (
    'cron_failures_24h',
    'purge_expired_missing',
    'unconfirmed_backlog',
    'audit_operator_volume',
    'audit_system_volume',
    'audit_webhook_volume',
    'operator_config_unlisted'
  )),
  value numeric not null check (value >= 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
alter table ops.alerts enable row level security;
alter table ops.alerts force row level security;
revoke all on ops.alerts from public, anon, authenticated, service_role, api_runtime;
grant select, insert, update on ops.alerts to ops;
create policy alerts_ops_all on ops.alerts for all to ops
  using (true) with check (true);

create function ops.purge_unconfirmed_users() returns void
language plpgsql security definer set search_path = '' as $$
declare
  c_batch constant integer := 500;
  c_max_rounds constant integer := 20;
  v_deleted integer;
  v_total integer := 0;
  v_round integer;
begin
  for v_round in 1..c_max_rounds loop
    v_deleted := identity.delete_unconfirmed_users();
    v_total := v_total + v_deleted;
    exit when v_deleted < c_batch;
  end loop;

  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('system', 'script:ops:purge_unconfirmed_users',
          'ops.purge_unconfirmed_users', 'ops.cron', 'success',
          gen_random_uuid()::text, jsonb_build_object('deleted_count', v_total));
end;
$$;
revoke all on function ops.purge_unconfirmed_users()
  from public, anon, authenticated, service_role, api_runtime, identity_system,
       privacy_system, app_config_system, platform_system, ops;
grant execute on function ops.purge_unconfirmed_users() to postgres;

create function ops.check_signals() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_signal record;
  v_now timestamptz := clock_timestamp();
begin
  for v_signal in
    select 'cron_failures_24h'::text as code, count(*)::numeric as value
    from cron.job_run_details d
    where d.status = 'failed' and d.start_time >= v_now - interval '24 hours'
    having count(*) > 0

    union all
    select 'purge_expired_missing', 1::numeric
    where not exists (
      select 1 from audit.events e
      where e.action = 'ops.purge_expired'
        and e.occurred_at >= v_now - interval '36 hours'
    )

    union all
    select 'unconfirmed_backlog', c.unconfirmed_count::numeric
    from identity.count_unconfirmed_users() as c(unconfirmed_count)
    where c.unconfirmed_count > 1000

    union all
    select 'audit_operator_volume', count(*)::numeric
    from audit.events e
    where e.actor_type = 'operator' and e.occurred_at >= v_now - interval '1 hour'
    having count(*) > 50

    union all
    select 'audit_system_volume', count(*)::numeric
    from audit.events e
    where e.actor_type = 'system' and e.occurred_at >= v_now - interval '1 hour'
    having count(*) > 1000

    union all
    select 'audit_webhook_volume', count(*)::numeric
    from audit.events e
    where e.actor_type = 'webhook' and e.occurred_at >= v_now - interval '1 hour'
    having count(*) > 2000

    union all
    select 'operator_config_unlisted', count(*)::numeric
    from audit.events e
    where e.actor_type = 'operator'
      and e.action = 'app_config.updated'
      and e.occurred_at >= v_now - interval '15 minutes'
      and not exists (
        select 1 from app_config.operator_alert_exempt_keys k
        where k.key = e.resource_ref
      )
    having count(*) > 0
  loop
    insert into ops.alerts (code, value, first_seen_at, last_seen_at)
    values (v_signal.code, v_signal.value, v_now, v_now)
    on conflict (code) do update
      set value = excluded.value, last_seen_at = excluded.last_seen_at;
  end loop;
end;
$$;
revoke all on function ops.check_signals()
  from public, anon, authenticated, service_role, api_runtime, identity_system,
       privacy_system, app_config_system, platform_system, ops;
grant execute on function ops.check_signals() to postgres;

-- PostgreSQL 17 ownership transfer uses a temporary SET-capable membership and
-- CREATE on the owning schema; both capabilities are removed after transfer.
grant create on schema ops to ops;
grant ops to postgres with set true, inherit false;
alter function ops.purge_unconfirmed_users() owner to ops;
alter function ops.check_signals() owner to ops;
alter function ops.app_config_change_count_last_hour() owner to ops;
select set_config('role', 'ops', true);
grant execute on function ops.purge_expired(), ops.purge_unconfirmed_users(),
  ops.check_signals() to postgres;
select set_config('role', 'postgres', true);
revoke ops from postgres;
revoke create on schema ops from ops;

select cron.schedule('ops-purge-expired', '17 3 * * *', 'select ops.purge_expired()');
select cron.schedule('ops-purge-unconfirmed-users', '47 3 * * *',
  'select ops.purge_unconfirmed_users()');
select cron.schedule('ops-check-signals', '*/15 * * * *', 'select ops.check_signals()');
-- Ownership transfer replaces the old owner's implicit ACL. Grant the cron
-- caller explicitly as the new owner, then remove the temporary membership.
grant ops to postgres with set true, inherit false;
select set_config('role', 'ops', true);
grant execute on function ops.purge_expired(), ops.check_signals() to postgres;
select set_config('role', 'postgres', true);
revoke ops from postgres;

-- The batch selector needs SELECT as well as DELETE, restricted to expired
-- rows. Its column grants remain limited to the keys and expiration timestamp.
create policy idem_ops_expired_select on platform.idempotency_keys
  for select to ops using (expires_at < now());

-- The writer capability exposes only set_setting, not its validation helpers.
revoke execute on function app_config.semver_key(text), app_config.valid_versions(jsonb)
  from public, anon, authenticated, api_runtime;
grant execute on function app_config.semver_key(text), app_config.valid_versions(jsonb)
  to app_config_admin;


-- Clear provider default function ACLs without granting runtime capabilities.
revoke execute on function app_config.semver_key(text), app_config.valid_versions(jsonb)
  from service_role;
grant ops to postgres with set true, inherit false;
select set_config('role', 'ops', true);
revoke execute on function ops.purge_expired(), ops.purge_unconfirmed_users(), ops.check_signals()
  from public, anon, authenticated, service_role, api_runtime;
select set_config('role', 'postgres', true);
revoke ops from postgres;
