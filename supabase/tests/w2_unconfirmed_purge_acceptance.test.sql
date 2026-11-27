begin;
set transaction isolation level repeatable read;
set local search_path = test_support, extensions, public;
select no_plan();

-- The purge locks Auth rows before writing its audit event. Preserve that
-- order, then isolate count-only audit assertions until this file rolls back.
lock table auth.users in share row exclusive mode;
lock table audit.events in access exclusive mode;
truncate table audit.events;

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        is_anonymous, created_at, updated_at)
select ('a0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'pgtap-helper-unconfirmed-' || n::text || '@example.invalid', null, false,
       clock_timestamp() - interval '4 days', clock_timestamp()
from generate_series(1, 501) as generated(n);

set local role ops;
select is(identity.delete_unconfirmed_users(), 500,
  'the Auth deletion helper removes at most 500 eligible accounts per call');
reset role;
select is(
  (select count(*)::integer from auth.users
   where id between 'a0000000-0000-4000-8000-000000000001'::uuid
                 and 'a0000000-0000-4000-8000-000000000501'::uuid),
  1,
  'one eligible account remains after the fixed 500-row helper batch'
);
set local role ops;
select is(identity.delete_unconfirmed_users(), 1,
  'the helper returns the exact count for the final partial batch');
reset role;

select ok(
  has_function_privilege('ops', 'identity.count_unconfirmed_users()', 'EXECUTE')
  and has_function_privilege('ops', 'identity.delete_unconfirmed_users()', 'EXECUTE')
  and not has_function_privilege('api_runtime', 'identity.count_unconfirmed_users()', 'EXECUTE')
  and not has_function_privilege('api_runtime', 'identity.delete_unconfirmed_users()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'identity.count_unconfirmed_users()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'identity.delete_unconfirmed_users()', 'EXECUTE'),
  'only ops can execute the fixed Auth count and delete helpers'
);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        is_anonymous, created_at, updated_at)
select ('c0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'pgtap-wrapper-unconfirmed-' || n::text || '@example.invalid', null, false,
       clock_timestamp() - interval '4 days', clock_timestamp()
from generate_series(1, 501) as generated(n);
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        is_anonymous, created_at, updated_at)
values
  ('b0000000-0000-4000-8000-000000000001',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'pgtap-young-unconfirmed@example.invalid', null, false,
   clock_timestamp() - interval '2 days', clock_timestamp()),
  ('b0000000-0000-4000-8000-000000000002',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'pgtap-old-confirmed@example.invalid', clock_timestamp() - interval '4 days', false,
   clock_timestamp() - interval '5 days', clock_timestamp()),
  ('b0000000-0000-4000-8000-000000000003',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'pgtap-old-anonymous@example.invalid', null, true,
   clock_timestamp() - interval '5 days', clock_timestamp()),
  ('b0000000-0000-4000-8000-000000000004',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   null, null, false,
   clock_timestamp() - interval '5 days', clock_timestamp()),
  ('b0000000-0000-4000-8000-000000000005',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   '', null, false,
   clock_timestamp() - interval '5 days', clock_timestamp()),
  ('b0000000-0000-4000-8000-000000000006',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   '   ', null, false,
   clock_timestamp() - interval '5 days', clock_timestamp());

select is(identity.count_unconfirmed_users(), 502::bigint,
  'the count includes recent and old e-mail accounts but excludes anonymous, null, and empty e-mails');
select ok(
  not has_table_privilege('ops', 'auth.users', 'SELECT')
  and not has_table_privilege('ops', 'auth.users', 'DELETE'),
  'ops accesses Auth users only through the narrow helper functions'
);

select ok(
  exists (
    select 1 from pg_catalog.pg_proc procedure
    where procedure.oid = pg_catalog.to_regprocedure('ops.purge_unconfirmed_users()')
      and procedure.proowner = 'ops'::regrole
      and procedure.prosecdef
      and procedure.prorettype = 'void'::regtype
      and 'search_path=""' = any(procedure.proconfig)
  ),
  'the ops purge wrapper is a void security definer with an empty search_path'
);
select ok(
  not has_function_privilege('api_runtime', 'ops.purge_unconfirmed_users()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'ops.purge_unconfirmed_users()', 'EXECUTE')
  and not has_function_privilege('anon', 'ops.purge_unconfirmed_users()', 'EXECUTE'),
  'runtime and client roles cannot execute the cron purge wrapper'
);
select ok(
  exists (
    select 1 from cron.job job
    where job.jobname = 'ops-purge-unconfirmed-users'
      and job.command = 'select ops.purge_unconfirmed_users()'
      and split_part(job.schedule, ' ', 1) ~ '^[0-5]?[0-9]$'
      and split_part(job.schedule, ' ', 2) ~ '^([01]?[0-9]|2[0-3])$'
      and split_part(job.schedule, ' ', 3) = '*'
      and split_part(job.schedule, ' ', 4) = '*'
      and split_part(job.schedule, ' ', 5) = '*'
  ),
  'the unconfirmed purge has one daily pg_cron job'
);

select lives_ok('select ops.purge_unconfirmed_users()',
  'the wrapper drains eligible accounts through bounded Auth-helper batches');
select is(
  (select count(*)::integer from auth.users
   where id between 'c0000000-0000-4000-8000-000000000001'::uuid
                 and 'c0000000-0000-4000-8000-000000000501'::uuid),
  0,
  'the wrapper removes all 501 eligible accounts across 500-row batches'
);
select is(
  (select count(*)::integer from auth.users
   where id between 'b0000000-0000-4000-8000-000000000001'::uuid
                 and 'b0000000-0000-4000-8000-000000000006'::uuid),
  6,
  'the purge preserves recent, confirmed, anonymous, null, empty, and whitespace-only e-mail accounts'
);
select is(
  (select count(*)::integer from audit.events
   where action = 'ops.purge_unconfirmed_users'),
  1,
  'one wrapper call creates exactly one count-only audit event'
);
select ok(
  exists (
    select 1 from audit.events event
    where event.action = 'ops.purge_unconfirmed_users'
      and event.actor_type = 'system'
      and event.metadata = '{"deleted_count":501}'::jsonb
  )
  and not exists (
    select 1 from audit.events event
    where event.action = 'ops.purge_unconfirmed_users'
      and event.metadata ?| array['email','user_id','token']
  ),
  'the wrapper audit records the exact count without personal data'
);

select lives_ok('select ops.purge_unconfirmed_users()',
  'the wrapper records an empty purge without an Auth-table grant');
select is(
  (select count(*)::integer from audit.events
   where action = 'ops.purge_unconfirmed_users'
     and metadata = '{"deleted_count":0}'::jsonb),
  1,
  'an empty purge records exactly one zero-count event'
);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        is_anonymous, created_at, updated_at)
values ('d0000000-0000-4000-8000-000000000001',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'pgtap-rollback-unconfirmed@example.invalid', null, false,
        clock_timestamp() - interval '4 days', clock_timestamp());
savepoint purge_rollback;
select ops.purge_unconfirmed_users();
rollback to savepoint purge_rollback;
select is(
  (select count(*)::integer from auth.users
   where id = 'd0000000-0000-4000-8000-000000000001'::uuid),
  1,
  'transaction rollback restores the deleted account'
);
select is(
  (select count(*)::integer from audit.events
   where action = 'ops.purge_unconfirmed_users'),
  2,
  'transaction rollback removes the matching purge audit event as well'
);

select * from finish();
rollback;
