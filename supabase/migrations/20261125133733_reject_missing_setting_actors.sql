-- Reject missing required actor values before quota checks or writes.
grant create on schema app_config to app_config_admin;
grant app_config_admin to postgres with set true, inherit false;
select set_config('role', 'app_config_admin', true);

create or replace function app_config.set_setting(
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
  if p_actor_type = 'system' and (p_actor_ref is null or p_actor_ref !~ '^script:app-config:[A-Za-z0-9_-]{1,64}$') then
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

revoke execute on function app_config.set_setting(text, jsonb, text, text, text, timestamptz)
  from public, anon, authenticated, service_role, api_runtime;

select set_config('role', 'postgres', true);
revoke app_config_admin from postgres;
revoke create on schema app_config from app_config_admin;

-- Clear provider default function ACLs without granting runtime capabilities.
revoke execute on function app_config.semver_key(text), app_config.valid_versions(jsonb)
  from service_role;
grant ops to postgres with set true, inherit false;
select set_config('role', 'ops', true);
revoke execute on function ops.purge_expired(), ops.check_signals()
  from public, anon, authenticated, service_role, api_runtime;
select set_config('role', 'postgres', true);
revoke ops from postgres;

grant usage on schema identity to auth_fn_owner;
grant auth_fn_owner to postgres with set true, inherit false;
select set_config('role', 'auth_fn_owner', true);
revoke execute on function identity.before_user_created(jsonb)
  from public, anon, authenticated, service_role, api_runtime;
select set_config('role', 'postgres', true);
revoke auth_fn_owner from postgres;
revoke usage on schema identity from auth_fn_owner;
