begin;
set local search_path = test_support, extensions, public;
select no_plan();

select set_config('test.maintenance_updated_at',
  (select updated_at::text from app_config.settings where key = 'maintenance'), true);
select set_config('test.maintenance_before',
  (select value::text from app_config.settings where key = 'maintenance'), true);

insert into audit.events (occurred_at, actor_type, actor_ref, action, resource_type,
                          resource_ref, outcome, correlation_id, metadata)
select clock_timestamp() - interval '10 minutes', 'system', 'script:app-config:pgtap',
       'app_config.updated', 'app_config.settings', 'maintenance', 'success',
       ('99999999-9999-4999-8999-' || lpad(n::text, 12, '0'))::uuid::text,
       jsonb_build_object('before', '{"active":false}'::jsonb,
                          'after', '{"active":false}'::jsonb)
from generate_series(1, 20) as generated(n);

select is(
  (select count(*)::integer from audit.events
   where action = 'app_config.updated'
     and occurred_at > clock_timestamp() - interval '1 hour'),
  20,
  'the quota fixture contains exactly twenty recent changes'
);

set local role app_config_writer;
select throws_ok($sql$
  select app_config.set_setting(
    'maintenance', '{"active":true}'::jsonb, 'system',
    'script:app-config:pgtap', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    current_setting('test.maintenance_updated_at', true)::timestamptz
  )
$sql$, '54000', null, 'the 21st setting change in one hour is rejected');
reset role;

select is(
  (select value::text from app_config.settings where key = 'maintenance'),
  current_setting('test.maintenance_before', true),
  'the over-quota write leaves settings unchanged'
);
select is(
  (select count(*)::integer from audit.events
   where correlation_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  0,
  'the over-quota write does not create an audit event'
);

select * from finish();
rollback;
