begin;
set local search_path = test_support, extensions, public;
select no_plan();

select ok(
  has_function_privilege('supabase_auth_admin',
    'identity.before_user_created(jsonb)', 'EXECUTE')
  and not has_function_privilege('api_runtime',
    'identity.before_user_created(jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'identity.before_user_created(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon',
    'identity.before_user_created(jsonb)', 'EXECUTE'),
  'only Supabase Auth can invoke the before-user-created hook'
);

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
select ('d0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'pgtap-signup-' || n::text || '@example.invalid',
       clock_timestamp() - interval '10 minutes', clock_timestamp()
from generate_series(1, 299) as generated(n);
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
values ('d0000000-0000-4000-8000-000000000300',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'pgtap-signup-outside-hour@example.invalid',
        clock_timestamp() - interval '61 minutes', clock_timestamp());

select is(
  identity.before_user_created('{}'::jsonb),
  '{}'::jsonb,
  'the hook allows a signup when only 299 accounts were created in the last hour'
);

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
values ('d0000000-0000-4000-8000-000000000301',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'pgtap-signup-300@example.invalid', clock_timestamp(), clock_timestamp());

select is(
  identity.before_user_created('{}'::jsonb),
  '{"error":{"message":"signups temporarily limited","http_code":429}}'::jsonb,
  'the hook rejects the 301st signup in the rolling hour with HTTP 429'
);

select * from finish();
rollback;
