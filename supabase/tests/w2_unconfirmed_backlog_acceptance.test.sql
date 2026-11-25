begin;
set local search_path = test_support, extensions, public;
select no_plan();

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        is_anonymous, created_at, updated_at)
select ('c0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'pgtap-backlog-' || n::text || '@example.invalid', null, false,
       clock_timestamp() - interval '1 day', clock_timestamp()
from generate_series(1, 1000) as generated(n);
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        is_anonymous, created_at, updated_at)
values
  ('c0000000-0000-4000-8000-000000001002',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'pgtap-anonymous-backlog@example.invalid', null, true,
   clock_timestamp() - interval '1 day', clock_timestamp()),
  ('c0000000-0000-4000-8000-000000001003',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   null, null, false,
   clock_timestamp() - interval '1 day', clock_timestamp());

set local role ops;
select is(identity.count_unconfirmed_users(), 1000::bigint,
  'the Auth count helper includes only non-anonymous accounts with an e-mail');
reset role;

select ok(
  not has_function_privilege('api_runtime', 'identity.count_unconfirmed_users()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'identity.count_unconfirmed_users()', 'EXECUTE')
  and not has_function_privilege('anon', 'identity.count_unconfirmed_users()', 'EXECUTE'),
  'the Auth count helper is unavailable to runtime and client roles'
);

select lives_ok('select ops.check_signals()',
  'check_signals evaluates the unconfirmed-account threshold');
select is(
  (select count(*)::integer from ops.alerts where code = 'unconfirmed_backlog'),
  0,
  'exactly one thousand unconfirmed accounts do not raise a backlog alert'
);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        is_anonymous, created_at, updated_at)
values ('c0000000-0000-4000-8000-000000001001',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'pgtap-backlog-1001@example.invalid', null, false,
        clock_timestamp() - interval '1 day', clock_timestamp());
select lives_ok('select ops.check_signals()',
  'check_signals records the unconfirmed backlog above one thousand');
select is(
  (select value from ops.alerts where code = 'unconfirmed_backlog'),
  1001::numeric,
  'the backlog alert records the count without exposing account data'
);

select * from finish();
rollback;
