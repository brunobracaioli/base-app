begin;
set local search_path = test_support, extensions, public;
select no_plan();

select set_config('test.maintenance_updated_at',
  (select updated_at::text from app_config.settings where key = 'maintenance'), true);

-- Test-only privileged fixture; it is never a runtime grant or role membership.
set local role postgres;
insert into audit.events (occurred_at, actor_type, actor_ref, action, resource_type,
                          resource_ref, outcome, correlation_id, metadata)
select clock_timestamp() - interval '10 minutes', 'system', 'script:app-config:pgtap',
       'app_config.updated', 'app_config.settings', 'maintenance', 'success',
       ('99999999-9999-4999-8999-' || lpad(n::text, 12, '0'))::uuid::text,
       jsonb_build_object('before', '{"active":false}'::jsonb,
                          'after', '{"active":false}'::jsonb)
from generate_series(1, 19) as generated(n);
reset role;

select is(
  (select count(*)::integer from audit.events
   where action = 'app_config.updated'
     and occurred_at > clock_timestamp() - interval '1 hour'),
  19,
  'the quota fixture contains nineteen recent changes'
);

select ok(
  has_function_privilege('app_config_admin',
    'ops.app_config_change_count_last_hour()', 'EXECUTE')
  and not has_function_privilege('app_config_writer',
    'ops.app_config_change_count_last_hour()', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'ops.app_config_change_count_last_hour()', 'EXECUTE'),
  'only the app-config administrator can execute the scalar quota helper'
);
select ok(
  exists (
    select 1 from pg_catalog.pg_proc procedure
    where procedure.oid = pg_catalog.to_regprocedure('ops.app_config_change_count_last_hour()')
      and procedure.proowner = 'ops'::regrole
      and procedure.prosecdef
      and procedure.prorettype = 'bigint'::regtype
      and 'search_path=""' = any(procedure.proconfig)
  ),
  'the quota helper is an ops-owned bigint security definer with an empty search_path'
);
set local role app_config_admin;
select is(ops.app_config_change_count_last_hour(), 19::bigint,
  'the quota helper returns only the count of recent app-config audit events');
select throws_ok('select count(*) from audit.events', '42501', null,
  'the administrator cannot select audit rows directly');
reset role;

set local role app_config_writer;
select lives_ok($sql$
  select app_config.set_setting(
    'maintenance', '{"active":true}'::jsonb, 'system',
    'script:app-config:pgtap', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    current_setting('test.maintenance_updated_at', true)::timestamptz
  )
$sql$, 'the 20th setting change in one hour is accepted');
reset role;

select is(
  (select count(*)::integer from audit.events
   where action = 'app_config.updated'
     and occurred_at > clock_timestamp() - interval '1 hour'),
  20,
  'the successful write brings the quota window to exactly twenty changes'
);
select is(
  (select value::text from app_config.settings where key = 'maintenance'),
  '{"active":true}',
  'the twentieth setting change is applied'
);
select set_config('test.maintenance_updated_at_after_twentieth',
  (select updated_at::text from app_config.settings where key = 'maintenance'), true);

set local role app_config_writer;
select throws_ok($sql$
  select app_config.set_setting(
    'maintenance', '{"active":true}'::jsonb, 'system',
    'script:app-config:pgtap', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    current_setting('test.maintenance_updated_at_after_twentieth', true)::timestamptz
  )
$sql$, '54000', null, 'the 21st setting change in one hour is rejected');
reset role;

select is(
  (select value::text from app_config.settings where key = 'maintenance'),
  '{"active":true}',
  'the over-quota write leaves settings unchanged'
);
select is(
  (select count(*)::integer from audit.events
   where correlation_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  0,
  'the over-quota write does not create an audit event'
);

select * from finish();
rollback;
