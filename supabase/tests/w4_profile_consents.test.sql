begin;
set local search_path = test_support, extensions, public;
select no_plan();

insert into auth.users (
  id, instance_id, aud, role, email, raw_app_meta_data, created_at, updated_at
)
values
  ('d4000000-0000-4000-8000-000000000001',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'pgtap-w4-profile-a@example.invalid', '{"roles":["billing_admin"]}', now(), now()),
  ('d4000000-0000-4000-8000-000000000002',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'pgtap-w4-profile-b@example.invalid', '{"roles":["billing_reader"]}', now(), now());

-- The second user's rows are setup fixtures. The test transaction rolls all of
-- these rows back and never changes any pre-existing account fixture.
insert into identity.profiles (user_id, display_name, locale)
values ('d4000000-0000-4000-8000-000000000002', 'Profile B', 'en-US');
insert into privacy.consents (user_id, document, version)
values ('d4000000-0000-4000-8000-000000000002', 'terms', '2026-11-24');

select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_catalog.pg_class where oid = 'identity.profiles'::regclass)
  and (select relrowsecurity and relforcerowsecurity
       from pg_catalog.pg_class where oid = 'privacy.consents'::regclass),
  'profiles and consents enforce row level security'
);

select is(
  (select string_agg(attribute.attname, ',' order by key_column.ordinality)
   from pg_catalog.pg_constraint constraint_row
   join pg_catalog.pg_class relation on relation.oid = constraint_row.conrelid
   join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
   cross join lateral unnest(constraint_row.conkey) with ordinality as key_column(attnum, ordinality)
   join pg_catalog.pg_attribute attribute
     on attribute.attrelid = relation.oid and attribute.attnum = key_column.attnum
   where namespace.nspname = 'privacy' and relation.relname = 'consents'
     and constraint_row.contype = 'p'),
  'user_id,document,version',
  'a consent is unique by user, legal document, and version'
);
select set_eq(
  $$
    select namespace.nspname || '.' || relation.relname || ':' || constraint_row.confdeltype::text
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class relation on relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where constraint_row.contype = 'f'
      and constraint_row.confrelid = 'auth.users'::regclass
      and relation.oid in ('identity.profiles'::regclass, 'privacy.consents'::regclass)
  $$,
  $$ values ('identity.profiles:c'::text), ('privacy.consents:c'::text) $$,
  'both user-owned tables cascade with account deletion'
);

select set_eq(
  $$
    select relation.relname || '.' || attribute.attname || ':' || privilege.privilege_type
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
    join pg_catalog.pg_roles role on role.oid = privilege.grantee
    where namespace.nspname = 'identity' and relation.relname = 'profiles'
      and attribute.attnum > 0 and not attribute.attisdropped
      and role.rolname = 'authenticated'
  $$,
  $$
    values ('profiles.display_name:UPDATE'::text),
           ('profiles.locale:UPDATE'::text),
           ('profiles.updated_at:UPDATE'::text)
  $$,
  'authenticated can update only the three documented profile columns'
);
select ok(
  not pg_catalog.has_table_privilege('authenticated', 'identity.profiles', 'UPDATE')
  and not pg_catalog.has_column_privilege('authenticated', 'identity.profiles', 'user_id', 'UPDATE')
  and not pg_catalog.has_column_privilege('authenticated', 'identity.profiles', 'created_at', 'UPDATE')
  and not pg_catalog.has_table_privilege('authenticated', 'privacy.consents', 'UPDATE')
  and not pg_catalog.has_table_privilege('authenticated', 'privacy.consents', 'DELETE')
  and not pg_catalog.has_table_privilege('api_runtime', 'identity.profiles', 'SELECT')
  and not pg_catalog.has_table_privilege('api_runtime', 'identity.profiles', 'INSERT')
  and not pg_catalog.has_table_privilege('api_runtime', 'privacy.consents', 'SELECT')
  and not pg_catalog.has_table_privilege('api_runtime', 'privacy.consents', 'INSERT')
  and not pg_catalog.has_table_privilege('anon', 'identity.profiles', 'SELECT')
  and not pg_catalog.has_table_privilege('anon', 'privacy.consents', 'SELECT'),
  'column and context grants expose no update, delete, runtime, or anonymous table access'
);

select is(
  pg_catalog.pg_get_function_result(
    pg_catalog.to_regprocedure('identity.read_fresh_roles(uuid)')
  ),
  'TABLE(roles jsonb)',
  'the fresh-role helper returns only one roles column'
);
select ok(
  (select not prosecdef and coalesce('search_path=""' = any(proconfig), false)
   from pg_catalog.pg_proc
   where oid = pg_catalog.to_regprocedure('identity.touch_updated_at()')),
  'the timestamp trigger is search-path isolated and runs as invoker'
);
select set_eq(
  $$
    select case when privilege.grantee = 0 then 'PUBLIC' else role.rolname end
    from pg_catalog.pg_proc procedure
    cross join lateral pg_catalog.aclexplode(
      coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) privilege
    left join pg_catalog.pg_roles role on role.oid = privilege.grantee
    where procedure.oid = pg_catalog.to_regprocedure('identity.read_fresh_roles(uuid)')
      and privilege.grantee <> procedure.proowner
      and privilege.privilege_type = 'EXECUTE'
  $$,
  $$ values ('authenticated'::text) $$,
  'only authenticated has EXECUTE on the fresh-role helper'
);
select ok(
  has_function_privilege('authenticated', 'identity.read_fresh_roles(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'identity.read_fresh_roles(uuid)', 'EXECUTE')
  and not has_function_privilege('api_runtime', 'identity.read_fresh_roles(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'identity.read_fresh_roles(uuid)', 'EXECUTE')
  and not has_function_privilege('ops', 'identity.read_fresh_roles(uuid)', 'EXECUTE'),
  'the fresh-role helper has no caller beyond authenticated and its postgres owner'
);

select set_config('request.jwt.claim.sub', 'd4000000-0000-4000-8000-000000000001', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"d4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"roles":["stale_jwt_role"]}}',
  true
);
set local role authenticated;

select lives_ok($sql$
  insert into identity.profiles (user_id, display_name, locale)
  values ('d4000000-0000-4000-8000-000000000001', 'Profile A', 'pt-BR')
$sql$, 'a user can create their own profile');
select lives_ok($sql$
  insert into privacy.consents (user_id, document, version)
  values ('d4000000-0000-4000-8000-000000000001', 'terms', '2026-11-24')
$sql$, 'a user can record their own consent');
select is(
  (select count(*)::integer from identity.profiles),
  1,
  'a user sees their own profile and not another user profile'
);
select is(
  (select count(*)::integer from privacy.consents),
  1,
  'a user sees their own consent and not another user consent'
);
select throws_ok($sql$
  insert into identity.profiles (user_id, display_name, locale)
  values ('d4000000-0000-4000-8000-000000000002', 'Forged Profile', 'en-US')
$sql$, '42501', null, 'a user cannot insert a profile for another user');
select throws_ok($sql$
  insert into privacy.consents (user_id, document, version)
  values ('d4000000-0000-4000-8000-000000000002', 'privacy', '2026-11-24')
$sql$, '42501', null, 'a user cannot record consent for another user');
select is(
  (with changed as (
     update identity.profiles set display_name = 'Forged B'
     where user_id = 'd4000000-0000-4000-8000-000000000002'
     returning 1
   ) select count(*)::integer from changed),
  0,
  'a user cannot update another profile through row-level security'
);
select throws_ok($sql$
  update identity.profiles set user_id = 'd4000000-0000-4000-8000-000000000002'
  where user_id = 'd4000000-0000-4000-8000-000000000001'
$sql$, '42501', null, 'a user cannot update the profile user_id column');
select throws_ok($sql$
  update identity.profiles set created_at = '2000-01-01T00:00:00Z'::timestamptz
  where user_id = 'd4000000-0000-4000-8000-000000000001'
$sql$, '42501', null, 'a user cannot update the profile created_at column');
select throws_ok($sql$
  update identity.profiles set display_name = ''
  where user_id = 'd4000000-0000-4000-8000-000000000001'
$sql$, '23514', null, 'a non-null display name cannot be empty');
select throws_ok($sql$
  update identity.profiles set display_name = repeat('x', 81)
  where user_id = 'd4000000-0000-4000-8000-000000000001'
$sql$, '23514', null, 'a display name cannot exceed 80 characters');
select throws_ok($sql$
  update identity.profiles set locale = 'en-us'
  where user_id = 'd4000000-0000-4000-8000-000000000001'
$sql$, '23514', null, 'a locale must match the documented language and region form');
select lives_ok($sql$
  update identity.profiles
  set display_name = 'Profile A Updated', locale = 'en-US',
      updated_at = '2000-01-01T00:00:00Z'::timestamptz
  where user_id = 'd4000000-0000-4000-8000-000000000001'
$sql$, 'a user can update only their profile fields');
select ok(
  (select display_name = 'Profile A Updated' and locale = 'en-US'
          and updated_at = transaction_timestamp()
   from identity.profiles where user_id = 'd4000000-0000-4000-8000-000000000001'),
  'the trigger replaces a caller-supplied updated_at with transaction time'
);
select throws_ok($sql$
  delete from identity.profiles where user_id = 'd4000000-0000-4000-8000-000000000001'
$sql$, '42501', null, 'a user cannot delete their profile');
select throws_ok($sql$
  update privacy.consents set accepted_at = transaction_timestamp()
  where user_id = 'd4000000-0000-4000-8000-000000000001'
$sql$, '42501', null, 'a user cannot update a consent');
select throws_ok($sql$
  delete from privacy.consents where user_id = 'd4000000-0000-4000-8000-000000000001'
$sql$, '42501', null, 'a user cannot delete a consent');
select throws_ok($sql$
  insert into privacy.consents (user_id, document, version)
  values ('d4000000-0000-4000-8000-000000000001', 'marketing', '2026-11-24')
$sql$, '23514', null, 'consents reject documents outside terms and privacy');
select throws_ok($sql$
  insert into privacy.consents (user_id, document, version)
  values ('d4000000-0000-4000-8000-000000000001', 'privacy', 'v1')
$sql$, '23514', null, 'consents require the documented version pattern');
select throws_ok($sql$
  insert into privacy.consents (user_id, document, version)
  values ('d4000000-0000-4000-8000-000000000001', 'terms', '2026-11-24')
$sql$, '23505', null, 'the same user cannot duplicate a consent version');

select is(
  (select roles from identity.read_fresh_roles('d4000000-0000-4000-8000-000000000001')),
  '["billing_admin"]'::jsonb,
  'the helper returns current raw Auth metadata instead of stale JWT app_metadata'
);
select throws_ok(
  $$select roles from identity.read_fresh_roles('d4000000-0000-4000-8000-000000000002')$$,
  '42501', null, 'the helper rejects a different user id'
);
select throws_ok(
  'select roles from identity.read_fresh_roles(null)',
  '42501', null, 'the helper rejects a null user id'
);
reset role;

select set_config('request.jwt.claim.sub', 'd4000000-0000-4000-8000-000000000003', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"d4000000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);
set local role authenticated;
select is(
  (select count(*)::integer
   from identity.read_fresh_roles('d4000000-0000-4000-8000-000000000003')),
  0,
  'the helper returns zero rows when the caller account does not exist'
);
reset role;

set local role anon;
select throws_ok(
  $$select roles from identity.read_fresh_roles('d4000000-0000-4000-8000-000000000001')$$,
  '42501', null, 'anon cannot invoke the fresh-role helper'
);
reset role;

set local role identity_system;
select is((select count(*)::integer from identity.profiles), 2,
  'identity_system can read profiles for account purge');
select lives_ok($sql$
  delete from identity.profiles where user_id = 'd4000000-0000-4000-8000-000000000002'
$sql$, 'identity_system can delete a profile for account purge');
select throws_ok($sql$
  insert into identity.profiles (user_id, display_name, locale)
  values ('d4000000-0000-4000-8000-000000000002', 'System Insert', 'en-US')
$sql$, '42501', null, 'identity_system cannot insert profiles');
reset role;

set local role privacy_system;
select is((select count(*)::integer from privacy.consents), 2,
  'privacy_system can read consents for account purge');
select lives_ok($sql$
  delete from privacy.consents where user_id = 'd4000000-0000-4000-8000-000000000002'
$sql$, 'privacy_system can delete a consent for account purge');
select throws_ok($sql$
  insert into privacy.consents (user_id, document, version)
  values ('d4000000-0000-4000-8000-000000000002', 'privacy', '2026-11-24')
$sql$, '42501', null, 'privacy_system cannot insert consents');
reset role;

select * from finish();
rollback;
