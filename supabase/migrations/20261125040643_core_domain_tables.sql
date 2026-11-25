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
  if p_actor_type not in ('system', 'operator') then
    raise exception 'invalid actor type' using errcode = '22023';
  end if;
  if p_actor_type = 'system' and p_actor_ref !~ '^script:app-config:[A-Za-z0-9_-]{1,64}$' then
    raise exception 'invalid system actor' using errcode = '22023';
  end if;
  if p_actor_type = 'operator' and (
    p_actor_ref !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_actor_ref is distinct from current_setting('app.operator_id', true)
  ) then
    raise exception 'operator does not match transaction context' using errcode = '42501';
  end if;

  -- Serialize same-key writes so a missing row cannot defeat the optimistic
  -- token when two writers race to create it.
  perform pg_advisory_xact_lock(hashtextextended('base-app-config:' || p_key, 0));
  perform pg_advisory_xact_lock(hashtextextended('base-app-config-hourly-limit', 0));
  if (select count(*) from audit.events
      where action = 'app_config.updated'
        and occurred_at > now() - interval '1 hour') >= c_max_changes_per_hour then
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
  from public;
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
