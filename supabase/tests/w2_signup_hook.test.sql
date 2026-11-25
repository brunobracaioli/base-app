begin;
set local search_path = test_support, extensions, public;
select no_plan();

-- Isolate the quota from any disposable local Auth smoke-test reservations.
-- This mutation is fixture setup and is restored by the final rollback.
truncate table identity.signup_reservations;

select ok(
  has_function_privilege('supabase_auth_admin',
    'identity.before_user_created(jsonb)', 'EXECUTE')
  and not has_function_privilege('api_runtime',
    'identity.before_user_created(jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'identity.before_user_created(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon',
    'identity.before_user_created(jsonb)', 'EXECUTE'),
  'only the Auth hook role can execute before_user_created'
);
select ok(
  not has_table_privilege('anon', 'identity.signup_reservations', 'SELECT')
  and not has_table_privilege('authenticated', 'identity.signup_reservations', 'SELECT')
  and not has_table_privilege('api_runtime', 'identity.signup_reservations', 'SELECT')
  and not has_table_privilege('identity_system', 'identity.signup_reservations', 'SELECT')
  and not has_table_privilege('ops', 'identity.signup_reservations', 'SELECT'),
  'signup reservations expose no direct reads to app roles'
);

set local role supabase_auth_admin;
select is(
  identity.before_user_created(null::jsonb),
  '{"error":{"message":"invalid signup event","http_code":400}}'::jsonb,
  'a null Auth event fails closed'
);
select is(
  identity.before_user_created('[]'::jsonb),
  '{"error":{"message":"invalid signup event","http_code":400}}'::jsonb,
  'a non-object Auth event fails closed'
);
select is(
  identity.before_user_created('{}'::jsonb),
  '{"error":{"message":"invalid signup event","http_code":400}}'::jsonb,
  'an event without a user object fails closed'
);
select is(
  identity.before_user_created('{"user":null}'::jsonb),
  '{"error":{"message":"invalid signup event","http_code":400}}'::jsonb,
  'an event with a null user fails closed'
);
select is(
  identity.before_user_created('{"user":{}}'::jsonb),
  '{}'::jsonb,
  'a valid anonymous signup user without an e-mail is accepted'
);
reset role;

insert into identity.signup_reservations (reserved_at)
select clock_timestamp() - interval '5 minutes'
from generate_series(1, 298);
insert into identity.signup_reservations (reserved_at)
values (clock_timestamp() - interval '61 minutes');

set local role supabase_auth_admin;
select is(
  identity.before_user_created('{"user":{}}'::jsonb),
  '{}'::jsonb,
  'the 300th reservation in the rolling hour is accepted'
);
select is(
  identity.before_user_created('{"user":{}}'::jsonb),
  '{"error":{"message":"signups temporarily limited","http_code":429}}'::jsonb,
  'the 301st reservation in the rolling hour is rejected with HTTP 429'
);
reset role;

select is(
  (select count(*)::integer from identity.signup_reservations
   where reserved_at > clock_timestamp() - interval '1 hour'),
  300,
  'the shared reservation table contains exactly 300 accepted calls in the rolling hour'
);
select is(
  (select count(*)::integer from identity.signup_reservations
   where reserved_at <= clock_timestamp() - interval '1 hour'),
  0,
  'the hook removes expired reservations before counting the window'
);
select set_eq(
  $$
    select attribute.attname
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = 'identity.signup_reservations'::regclass
      and attribute.attnum > 0 and not attribute.attisdropped
  $$,
  $$ values ('reservation_id'::text), ('reserved_at'::text) $$,
  'signup reservations store only an opaque identifier and timestamp'
);

select * from finish();
rollback;
