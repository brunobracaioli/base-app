begin;
set local search_path = test_support, extensions, public;
select no_plan();

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
select ('a0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'pgtap-stale-unconfirmed-' || n::text || '@example.invalid', null,
       clock_timestamp() - interval '4 days', clock_timestamp()
from generate_series(1, 501) as generated(n);
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('b0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pgtap-young-unconfirmed@example.invalid', null,
   clock_timestamp() - interval '2 days', clock_timestamp()),
  ('b0000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pgtap-old-confirmed@example.invalid',
   clock_timestamp() - interval '4 days', clock_timestamp() - interval '5 days',
   clock_timestamp());

-- Required acceptance remains red until the owner chooses an approved audit
-- write path for this auth_fn_owner-owned routine. Do not add a grant or helper here.
select ok(
  exists (
    select 1 from pg_catalog.pg_proc procedure
    where procedure.oid = pg_catalog.to_regprocedure('ops.purge_unconfirmed_users()')
      and procedure.proowner = 'auth_fn_owner'::regrole
      and procedure.prosecdef
      and 'search_path=""' = any(procedure.proconfig)
  ),
  'purge_unconfirmed_users is auth-owned and has an empty search_path (audit path held)'
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
  'unconfirmed-user purge has one daily pg_cron job (audit path held)'
);
select lives_ok('select ops.purge_unconfirmed_users()',
  'the stale-unconfirmed purge deletes accounts in batches');
select is(
  (select count(*)::integer from auth.users
   where id between 'a0000000-0000-4000-8000-000000000001'::uuid
                 and 'a0000000-0000-4000-8000-000000000501'::uuid),
  0,
  'all 501 unconfirmed accounts older than three days are deleted across batches'
);
select is(
  (select count(*)::integer from auth.users
   where id = 'b0000000-0000-4000-8000-000000000001'::uuid),
  1,
  'an unconfirmed account younger than three days is retained'
);
select is(
  (select count(*)::integer from auth.users
   where id = 'b0000000-0000-4000-8000-000000000002'::uuid),
  1,
  'a confirmed account is retained regardless of age'
);
select is(
  (select count(*)::integer from audit.events
   where action = 'ops.purge_unconfirmed_users'),
  1,
  'the purge records one audit event with its deletion count'
);
select ok(
  exists (
    select 1 from audit.events event
    cross join lateral jsonb_each(event.metadata) item
    where event.action = 'ops.purge_unconfirmed_users'
      and event.actor_type = 'system'
      and item.value = '501'::jsonb
      and not (event.metadata ?| array['email','user_id','token'])
  ),
  'the unconfirmed-purge event contains the count and no personal data'
);

select * from finish();
rollback;
