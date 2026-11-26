-- W5 adds narrow setting reads, an audited force flag, restricted rollback
-- history, and decimal-safe semantic version comparison without rewriting W2.

do $w5$
begin
  -- Hold out concurrent inserts through the check and policy installation. Old
  -- rows cannot be trusted because W2 writers could forge this action.
  lock table audit.events in share row exclusive mode;
  if exists (
    select 1 from audit.events as event where event.action = 'app_config.updated'
  ) then
    raise exception using
      errcode = '55000',
      message = 'W5 requires explicit reconciliation of existing app_config.updated history; no rows were changed';
  end if;
  execute $policy$
    create policy events_restrict_app_config_updated on audit.events as restrictive
      for insert to public
      with check (action <> 'app_config.updated' or current_user = 'app_config_admin')
  $policy$;
end
$w5$;

-- BYPASSRLS is not a substitute for table-level least privilege.
revoke all on audit.events from service_role;

create role app_config_history_reader nologin noinherit nosuperuser nocreatedb
  nocreaterole noreplication nobypassrls;

grant usage on schema app_config, audit to app_config_history_reader;
revoke all on audit.events from app_config_history_reader;
grant select (id, occurred_at, action, resource_type, resource_ref, outcome, metadata)
  on audit.events to app_config_history_reader;

create policy events_select_app_config_history on audit.events for select
  to app_config_history_reader using (
    action = 'app_config.updated'
    and resource_type = 'app_config.settings'
    and outcome = 'success'
    and actor_type in ('system', 'operator')
  );

-- Compare non-negative decimal strings by significant length and byte order.
-- This matches the TypeScript contract for components longer than int32.
create function app_config.compare_decimal_components(p_left text, p_right text)
returns integer
language sql immutable parallel safe set search_path = '' as $$
  with normalized as (
    select coalesce(nullif(pg_catalog.ltrim(p_left, '0'), ''), '0') as left_value,
           coalesce(nullif(pg_catalog.ltrim(p_right, '0'), ''), '0') as right_value
  )
  select case
    when pg_catalog.length(left_value) < pg_catalog.length(right_value) then -1
    when pg_catalog.length(left_value) > pg_catalog.length(right_value) then 1
    when left_value collate "C" < right_value collate "C" then -1
    when left_value collate "C" > right_value collate "C" then 1
    else 0
  end
  from normalized
$$;
revoke all on function app_config.compare_decimal_components(text, text)
  from public, anon, authenticated, service_role, api_runtime, migrator,
       identity_system, privacy_system, app_config_system, platform_system,
       app_config_writer, app_config_history_reader, audit_writer,
       audit_operator_writer, audit_reader, ops;
grant execute on function app_config.compare_decimal_components(text, text)
  to app_config_admin;

create or replace function app_config.valid_versions(p_value jsonb) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  with platform_versions as (
    select platform,
           p_value -> platform ->> 'minSupported' as minimum_version,
           p_value -> platform ->> 'latest' as latest_version,
           p_value -> platform ->> 'published' as published_version
    from pg_catalog.unnest(array['ios', 'android']::text[]) as platforms(platform)
  ),
  version_components as (
    select platform, minimum_version, latest_version, published_version,
           pg_catalog.string_to_array(minimum_version, '.') as minimum_parts,
           pg_catalog.string_to_array(latest_version, '.') as latest_parts
    from platform_versions
  ),
  version_comparisons as (
    select platform, minimum_version, latest_version, published_version,
           app_config.compare_decimal_components(minimum_parts[1], latest_parts[1])
             as major_order,
           app_config.compare_decimal_components(minimum_parts[2], latest_parts[2])
             as minor_order,
           app_config.compare_decimal_components(minimum_parts[3], latest_parts[3])
             as patch_order
    from version_components
  )
  select coalesce(pg_catalog.bool_and(coalesce(
    minimum_version ~ '^\d+\.\d+\.\d+$'
    and latest_version ~ '^\d+\.\d+\.\d+$'
    and case
      when major_order < 0 then true
      when major_order > 0 then false
      when minor_order < 0 then true
      when minor_order > 0 then false
      else patch_order <= 0
    end
    and (published_version is null or published_version ~ '^\d+\.\d+\.\d+$'),
    false
  )), false)
  from version_comparisons
$$;

create function app_config.read_setting(p_key text)
returns table (value jsonb, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select setting.value, setting.updated_at
  from app_config.settings as setting
  where p_key = any (array['versions', 'maintenance', 'legal']::text[])
    and setting.key = p_key
$$;

create function app_config.read_rollback_setting(p_key text)
returns table (
  event_id uuid,
  before_value jsonb,
  after_value jsonb,
  occurred_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select event.id,
         event.metadata -> 'before',
         event.metadata -> 'after',
         event.occurred_at
  from audit.events as event
  where p_key = any (array['versions', 'maintenance', 'legal']::text[])
    and event.action = 'app_config.updated'
    and event.resource_type = 'app_config.settings'
    and event.resource_ref = p_key
    and event.outcome = 'success'
  order by event.occurred_at desc, event.id desc
  limit 1
$$;

create or replace function app_config.set_setting(
  p_key text, p_value jsonb, p_actor_type text, p_actor_ref text,
  p_correlation_id text, p_expected_updated_at timestamptz, p_force boolean
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
  if p_force is null then
    raise exception 'force flag is required' using errcode = '22023';
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

  -- Preserve READ COMMITTED CAS and serialize both the key and hourly quota.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'app_config requires read committed isolation' using errcode = '25001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('base-app-config:' || p_key, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('base-app-config-hourly-limit', 0)
  );
  if ops.app_config_change_count_last_hour() >= c_max_changes_per_hour then
    raise exception 'too many app_config changes' using errcode = '54000';
  end if;

  select setting.value, setting.updated_at into v_before, v_updated_at
  from app_config.settings as setting
  where setting.key = p_key;
  if v_updated_at is distinct from p_expected_updated_at then
    raise exception 'app_config conflict' using errcode = 'AC409';
  end if;

  insert into app_config.settings (key, value, updated_at)
  values (p_key, p_value, pg_catalog.clock_timestamp())
  on conflict (key) do update
    set value = excluded.value, updated_at = excluded.updated_at;

  insert into audit.events (actor_type, actor_ref, action, resource_type, resource_ref,
                            outcome, correlation_id, metadata)
  values (p_actor_type, p_actor_ref, 'app_config.updated', 'app_config.settings', p_key,
          'success', p_correlation_id,
          pg_catalog.jsonb_build_object('before', v_before, 'after', p_value,
                                        'force', p_force));
end;
$$;

-- Temporary ownership capabilities follow the PostgreSQL 17 W2 pattern.
grant create on schema app_config to app_config_admin, app_config_history_reader;
grant app_config_admin, app_config_history_reader to postgres with set true, inherit false;
alter function app_config.set_setting(text, jsonb, text, text, text, timestamptz, boolean)
  owner to app_config_admin;
alter function app_config.read_setting(text) owner to app_config_admin;
alter function app_config.read_rollback_setting(text) owner to app_config_history_reader;

select set_config('role', 'app_config_admin', true);
create or replace function app_config.set_setting(
  p_key text, p_value jsonb, p_actor_type text, p_actor_ref text,
  p_correlation_id text, p_expected_updated_at timestamptz
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app_config.set_setting(p_key, p_value, p_actor_type, p_actor_ref,
                                 p_correlation_id, p_expected_updated_at, false);
end;
$$;

alter function app_config.set_setting(text, jsonb, text, text, text, timestamptz)
  owner to app_config_admin;
revoke all on function app_config.set_setting(
  text, jsonb, text, text, text, timestamptz, boolean
), app_config.set_setting(text, jsonb, text, text, text, timestamptz),
  app_config.read_setting(text)
  from public, anon, authenticated, service_role, api_runtime, migrator,
       identity_system, privacy_system, app_config_system, platform_system,
       app_config_history_reader, audit_writer, audit_operator_writer,
       audit_reader, ops;
grant execute on function app_config.set_setting(
  text, jsonb, text, text, text, timestamptz, boolean
), app_config.set_setting(text, jsonb, text, text, text, timestamptz),
  app_config.read_setting(text)
  to app_config_writer;
select set_config('role', 'postgres', true);

select set_config('role', 'app_config_history_reader', true);
revoke all on function app_config.read_rollback_setting(text)
  from public, anon, authenticated, service_role, api_runtime, migrator,
       identity_system, privacy_system, app_config_system, platform_system,
       app_config_admin, audit_writer, audit_operator_writer, audit_reader, ops;
grant execute on function app_config.read_rollback_setting(text)
  to app_config_writer;
select set_config('role', 'postgres', true);
revoke app_config_admin, app_config_history_reader from postgres;
revoke create on schema app_config from app_config_admin, app_config_history_reader;
