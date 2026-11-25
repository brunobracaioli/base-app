begin;
set local search_path = test_support, extensions, public;
select no_plan();

insert into cron.job_run_details (username, status, start_time)
values ('ops', 'failed', clock_timestamp());

insert into audit.events (id, occurred_at, actor_type, actor_ref, action, resource_type,
                          resource_ref, outcome, correlation_id, metadata)
select ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       clock_timestamp(), 'operator', '11111111-1111-4111-8111-111111111111',
       'test.operator_volume', 'test', 'event', 'success',
       ('20000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid::text, '{}'
from generate_series(1, 51) as generated(n);
insert into audit.events (id, occurred_at, actor_type, actor_ref, action, resource_type,
                          resource_ref, outcome, correlation_id, metadata)
select ('30000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       clock_timestamp(), 'system', 'script:pgtap:signals', 'test.system_volume', 'test',
       'event', 'success',
       ('40000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid::text, '{}'
from generate_series(1, 1001) as generated(n);
insert into audit.events (id, occurred_at, actor_type, actor_ref, action, resource_type,
                          resource_ref, outcome, correlation_id, metadata)
select ('50000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       clock_timestamp(), 'webhook', null, 'test.webhook_volume', 'test', 'event',
       'success', ('60000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid::text, '{}'
from generate_series(1, 2001) as generated(n);
insert into audit.events (actor_type, actor_ref, action, resource_type, resource_ref,
                          outcome, correlation_id, metadata)
values ('operator', '11111111-1111-4111-8111-111111111111', 'app_config.updated',
        'app_config.settings', 'maintenance', 'success',
        '77777777-7777-4777-8777-777777777771', '{}');
insert into app_config.operator_alert_exempt_keys (key) values ('legal');
insert into audit.events (actor_type, actor_ref, action, resource_type, resource_ref,
                          outcome, correlation_id, metadata)
values ('operator', '11111111-1111-4111-8111-111111111111', 'app_config.updated',
        'app_config.settings', 'legal', 'success',
        '77777777-7777-4777-8777-777777777772', '{}');

select lives_ok('select ops.check_signals()',
  'check_signals persists the configured maintenance alerts');
select set_eq(
  $$ select code from ops.alerts $$,
  $$
    values ('cron_failures_24h'::text), ('purge_expired_missing'::text),
           ('audit_operator_volume'::text), ('audit_system_volume'::text),
           ('audit_webhook_volume'::text), ('operator_config_unlisted'::text)
  $$,
  'the active maintenance signals include failure, retention, audit volume, and unlisted operator changes'
);
select is((select value from ops.alerts where code = 'cron_failures_24h'), 1::numeric,
  'cron failures are counted in the alert');
select is((select value from ops.alerts where code = 'purge_expired_missing'), 1::numeric,
  'a missing purge heartbeat raises an alert');
select is((select value from ops.alerts where code = 'audit_operator_volume'), 53::numeric,
  'operator audit volume counts rows above the 50-event threshold');
select is((select value from ops.alerts where code = 'audit_system_volume'), 1001::numeric,
  'system audit volume counts rows above the 1000-event threshold');
select is((select value from ops.alerts where code = 'audit_webhook_volume'), 2001::numeric,
  'webhook audit volume counts rows above the 2000-event threshold');
select is((select value from ops.alerts where code = 'operator_config_unlisted'), 1::numeric,
  'an unexempt operator setting change raises an alert while an exempt key does not');
select ok(
  not exists (
    select 1 from ops.alerts
    where last_sent_at is not null or request_id is not null
  ),
  'missing Vault credentials persist alerts without marking or sending them'
);

update ops.alerts
set last_sent_at = now() - interval '1 hour', request_id = 987654321
where code in (
  'cron_failures_24h', 'purge_expired_missing', 'audit_operator_volume',
  'audit_system_volume', 'audit_webhook_volume', 'operator_config_unlisted'
);
select set_config('test.alert_dedupe_at',
  (select min(last_sent_at)::text from ops.alerts), true);
select lives_ok('select ops.check_signals()',
  'check_signals can re-evaluate alerts inside the six-hour dedupe interval');
select is(
  (select count(*)::integer from ops.alerts
   where code in (
     'cron_failures_24h', 'purge_expired_missing', 'audit_operator_volume',
     'audit_system_volume', 'audit_webhook_volume', 'operator_config_unlisted'
   )),
  6,
  'repeated signal checks keep one row per alert code'
);
select ok(
  (select bool_and(last_sent_at = current_setting('test.alert_dedupe_at', true)::timestamptz
                   and request_id = 987654321)
   from ops.alerts
   where code in (
     'cron_failures_24h', 'purge_expired_missing', 'audit_operator_volume',
     'audit_system_volume', 'audit_webhook_volume', 'operator_config_unlisted'
   )),
  'a recent last_sent_at suppresses repeat delivery without network calls'
);

select * from finish();
rollback;
