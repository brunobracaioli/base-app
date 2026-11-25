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
