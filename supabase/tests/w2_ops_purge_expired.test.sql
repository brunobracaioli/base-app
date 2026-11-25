begin;
set local search_path = test_support, extensions, public;
select no_plan();
select ok(has_function_privilege('postgres', 'ops.purge_expired()', 'EXECUTE')
  and has_function_privilege('postgres', 'ops.check_signals()', 'EXECUTE'),
  'the cron executor retains explicit execution after ownership transfer');

select ok(
  exists (
    select 1 from pg_catalog.pg_proc procedure
    where procedure.oid = pg_catalog.to_regprocedure('ops.purge_expired()')
      and procedure.proowner = 'ops'::regrole
      and procedure.prosecdef
      and 'search_path=""' = any(procedure.proconfig)
  ),
  'purge_expired is owned by ops and has an empty search_path'
);
select ok(
  not has_function_privilege('api_runtime', 'ops.purge_expired()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'ops.purge_expired()', 'EXECUTE')
  and not has_function_privilege('identity_system', 'ops.purge_expired()', 'EXECUTE')
  and not has_function_privilege('privacy_system', 'ops.purge_expired()', 'EXECUTE')
  and not has_function_privilege('app_config_system', 'ops.purge_expired()', 'EXECUTE')
  and not has_function_privilege('platform_system', 'ops.purge_expired()', 'EXECUTE'),
  'only the maintenance runner can execute purge_expired'
);

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'pgtap-purge@example.invalid', now(), now());

insert into audit.events (id, occurred_at, actor_type, actor_ref, action, resource_type,
                          outcome, correlation_id, metadata)
select ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       clock_timestamp() - interval '13 months', 'system', 'script:pgtap:expired',
       'test.expired', 'test', 'success',
       ('20000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid::text, '{}'
from generate_series(1, 5001) as generated(n);
insert into audit.events (id, occurred_at, actor_type, actor_ref, action, resource_type,
                          outcome, correlation_id, metadata)
values ('10000000-0000-4000-8000-999999999999',
        clock_timestamp() - interval '11 months', 'system', 'script:pgtap:retained',
        'test.retained', 'test', 'success',
        '20000000-0000-4000-8000-999999999999', '{}');

insert into platform.idempotency_keys
  (user_id, key, request_hash, state, locked_until, expires_at)
select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       ('30000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       repeat('a', 64), 'in_progress',
       clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 minute'
from generate_series(1, 5001) as generated(n);
insert into platform.idempotency_keys
  (user_id, key, request_hash, state, locked_until, expires_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'ffffffff-ffff-4fff-8fff-ffffffffffff', repeat('f', 64), 'in_progress',
        clock_timestamp() + interval '1 minute', clock_timestamp() + interval '24 hours');

select lives_ok('select ops.purge_expired()',
  'purge_expired removes expired rows across more than one batch');
select is(
  (select count(*)::integer from audit.events where action = 'test.expired'),
  0,
  'purge_expired removes every expired audit event'
);
select is(
  (select count(*)::integer from audit.events where action = 'test.retained'),
  1,
  'purge_expired preserves audit events within the retention window'
);
select is(
  (select count(*)::integer from platform.idempotency_keys
   where expires_at < clock_timestamp()),
  0,
  'purge_expired removes expired idempotency rows across more than one batch'
);
select is(
  (select count(*)::integer from platform.idempotency_keys
   where key = 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
  1,
  'purge_expired preserves unexpired idempotency rows'
);
select ok(
  exists (
    select 1 from audit.events
    where action = 'ops.purge_expired'
      and metadata ->> 'audit_events_deleted' = '5001'
      and metadata ->> 'idempotency_keys_deleted' = '5001'
      and not (metadata ?| array['email','user_id','token'])
  ),
  'purge_expired records deletion counts without personal data'
);

select lives_ok('select ops.purge_expired()',
  'purge_expired runs again when there is nothing left to remove');
select is(
  (select count(*)::integer from audit.events where action = 'ops.purge_expired'),
  2,
  'each purge run records exactly one heartbeat event'
);
select ok(
  exists (
    select 1 from audit.events
    where action = 'ops.purge_expired'
      and metadata ->> 'audit_events_deleted' = '0'
      and metadata ->> 'idempotency_keys_deleted' = '0'
  ),
  'a zero-count purge still records the heartbeat and zero counts'
);

select set_eq(
  $$
    select jobname, schedule, command from cron.job where jobname like 'ops-%'
  $$,
  $$
    values ('ops-purge-expired'::text, '17 3 * * *'::text,
            'select ops.purge_expired()'::text),
           ('ops-check-signals'::text, '*/15 * * * *'::text,
            'select ops.check_signals()'::text)
  $$,
  'the implemented maintenance routines have their exact pg_cron schedules'
);

select * from finish();
rollback;
