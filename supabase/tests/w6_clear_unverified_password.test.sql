begin;
set local search_path = test_support, extensions, public;
select no_plan();

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
)
values
  ('d6000000-0000-4000-8000-000000000001',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'pgtap-w6-pre-hijack@example.invalid', 'attacker-password-hash', null, now(), now()),
  ('d6000000-0000-4000-8000-000000000002',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'pgtap-w6-existing-confirmed@example.invalid', 'confirmed-password-hash', now(), now(), now());

select ok(
  (select procedure.proowner = 'postgres'::regrole
      and procedure.prosecdef
      and coalesce('search_path=""' = any(procedure.proconfig), false)
   from pg_catalog.pg_proc procedure
   where procedure.oid = pg_catalog.to_regprocedure('identity.clear_unverified_password()')),
  'the Auth password cleanup trigger function is postgres-owned, SECURITY DEFINER, and search-path isolated'
);

select is(
  pg_catalog.pg_get_function_result(
    pg_catalog.to_regprocedure('identity.clear_unverified_password()')
  ),
  'trigger',
  'the Auth password cleanup function returns trigger'
);

select set_eq(
  $$
    select case when privilege.grantee = 0 then 'PUBLIC' else role.rolname end
    from pg_catalog.pg_proc procedure
    cross join lateral pg_catalog.aclexplode(
      coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) privilege
    left join pg_catalog.pg_roles role on role.oid = privilege.grantee
    where procedure.oid = pg_catalog.to_regprocedure('identity.clear_unverified_password()')
      and privilege.grantee <> procedure.proowner
      and privilege.privilege_type = 'EXECUTE'
  $$,
  $$ values ('supabase_auth_admin'::text) $$,
  'only the Auth administrator can execute the trigger function outside its owner'
);

select is(
  (select count(*)::integer
   from pg_catalog.pg_trigger trigger_row
   where trigger_row.tgrelid = 'auth.users'::regclass
     and trigger_row.tgfoid = 'identity.clear_unverified_password()'::regprocedure
     and not trigger_row.tgisinternal),
  1,
  'the password cleanup function is attached once to the managed Auth users table'
);

set local role supabase_auth_admin;
update auth.users
set email_confirmed_at = transaction_timestamp()
where id = 'd6000000-0000-4000-8000-000000000001';
reset role;

select is(
  (select encrypted_password from auth.users
   where id = 'd6000000-0000-4000-8000-000000000001'),
  '',
  'confirming an unverified account clears a password set before email ownership was proven'
);

update auth.users
set email_confirmed_at = transaction_timestamp() + interval '1 second'
where id = 'd6000000-0000-4000-8000-000000000002';

select is(
  (select encrypted_password from auth.users
   where id = 'd6000000-0000-4000-8000-000000000002'),
  'confirmed-password-hash',
  'the trigger leaves a password unchanged when an already-confirmed account is updated'
);

select * from finish();
rollback;
