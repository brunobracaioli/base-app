create function identity.before_user_created(event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c_cap constant int := 300;
  v_recent_count bigint;
begin
  select count(*) into v_recent_count
  from auth.users u
  where u.created_at > clock_timestamp() - interval '1 hour';

  if v_recent_count >= c_cap then
    return jsonb_build_object('error', jsonb_build_object(
      'message', 'signups temporarily limited', 'http_code', 429));
  end if;
  return '{}'::jsonb;
end;
$$;
comment on function identity.before_user_created(jsonb) is
  'Rejects the 301st signup in a rolling hour; auth_fn_owner has SELECT only on auth.users.';

revoke all on function identity.before_user_created(jsonb)
  from public, anon, authenticated, api_runtime;
grant usage on schema identity to supabase_auth_admin;
grant execute on function identity.before_user_created(jsonb) to supabase_auth_admin;

-- PostgreSQL 17 requires temporary ownership-transfer capabilities. Object
-- grants are configured first; the migration removes its own membership again.
grant create on schema identity to auth_fn_owner;
grant auth_fn_owner to postgres with set true, inherit false;
alter function identity.before_user_created(jsonb) owner to auth_fn_owner;
revoke auth_fn_owner from postgres;
revoke create on schema identity from auth_fn_owner;


-- Scheduled unconfirmed-user purging is intentionally not defined until its
-- required audit-count write path for auth_fn_owner is owner-approved.
