begin;
set transaction isolation level repeatable read;
set local search_path = test_support, extensions, public;
select no_plan();

-- Take source locks before ops.alerts, matching the signal query's read-then-
-- write order. Do not lock cron.job_run_details: a cron worker may record its
-- run after executing a signal function that is waiting on audit.events.
lock table auth.users in share row exclusive mode;
lock table audit.events in access exclusive mode;
truncate table audit.events;
lock table app_config.operator_alert_exempt_keys in share row exclusive mode;
delete from app_config.operator_alert_exempt_keys
where key in ('maintenance', 'legal');
lock table ops.alerts in access exclusive mode;
truncate table ops.alerts;

create temporary table expected_cron_failures on commit drop as
select count(*)::numeric + 1 as value
from cron.job_run_details
where status = 'failed'
  and start_time >= transaction_timestamp() - interval '24 hours';

insert into cron.job_run_details (username, status, start_time)
values ('ops', 'failed', clock_timestamp());

-- A stale heartbeat is retained in the fixture so the 36-hour cutoff is
-- covered even when this test runs after earlier pg_cron executions.
insert into audit.events (id, occurred_at, actor_type, actor_ref, action, resource_type,
                          outcome, correlation_id, metadata)
values ('70000000-0000-4000-8000-000000000001',
        clock_timestamp() - interval '37 hours', 'system', 'script:pgtap:signals',
        'ops.purge_expired', 'ops.cron', 'success',
        '70000000-0000-4000-8000-000000000002', '{}');

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
  $$
    select attribute.attname
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = 'ops.alerts'::regclass
      and attribute.attnum > 0 and not attribute.attisdropped
  $$,
  $$ values ('code'::text), ('value'::text), ('first_seen_at'::text), ('last_seen_at'::text) $$,
  'ops.alerts stores only the approved local signal fields'
);
select set_eq(
  $$ select code from ops.alerts $$,
  $$
    values ('cron_failures_24h'::text), ('purge_expired_missing'::text),
           ('audit_operator_volume'::text), ('audit_system_volume'::text),
           ('audit_webhook_volume'::text), ('operator_config_unlisted'::text)
  $$,
  'the active maintenance signals include failure, retention, audit volume, and unlisted operator changes'
);
select is((select value from ops.alerts where code = 'cron_failures_24h'),
  (select value from expected_cron_failures),
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
  (select bool_and(first_seen_at = last_seen_at)
   from ops.alerts),
  'new alerts persist local first-seen and last-seen timestamps only'
);

create temporary table expected_alert_timestamps on commit drop as
select code, first_seen_at, last_seen_at
from ops.alerts
where code in (
  'cron_failures_24h', 'purge_expired_missing', 'audit_operator_volume',
  'audit_system_volume', 'audit_webhook_volume', 'operator_config_unlisted'
);
select lives_ok('select ops.check_signals()',
  'check_signals can re-evaluate persisted alerts without an external notifier');
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
  (select count(*) = 6 and bool_and(
      alert.first_seen_at = expected.first_seen_at
      and alert.last_seen_at >= expected.last_seen_at
    )
   from expected_alert_timestamps expected
   join ops.alerts alert using (code)),
  'repeated signals preserve first-seen and refresh last-seen timestamps'
);

select * from finish();
rollback;
