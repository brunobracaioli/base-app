begin;
set local search_path = test_support, extensions, public;
select no_plan();

select ok(
  (select rolcanlogin and not rolinherit and not rolsuper and not rolcreatedb
      and not rolcreaterole and not rolreplication and not rolbypassrls
   from pg_catalog.pg_roles where rolname = 'api_runtime'),
  'api_runtime can log in but cannot inherit or escalate'
);

select ok(
  (select count(*) = 11
      and bool_and(not rolcanlogin and not rolsuper and not rolcreatedb
                   and not rolcreaterole and not rolreplication and not rolbypassrls)
   from pg_catalog.pg_roles
   where rolname = any (array[
     'migrator', 'identity_system', 'privacy_system', 'app_config_system', 'platform_system',
     'ops', 'app_config_admin', 'audit_writer',
     'audit_operator_writer', 'audit_reader', 'app_config_writer'
   ])),
  'Wave 2 capability roles are present, NOLOGIN, and unprivileged'
);

select set_eq(
  $$
    select namespace.nspname, privilege.privilege_type
    from pg_catalog.pg_namespace namespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
    ) privilege
    where namespace.nspname in ('identity','privacy','app_config','platform','audit','ops')
      and privilege.grantee = 'migrator'::regrole
  $$,
  $$
    values ('identity'::text, 'USAGE'::text), ('identity'::text, 'CREATE'::text),
           ('privacy'::text, 'USAGE'::text), ('privacy'::text, 'CREATE'::text),
           ('app_config'::text, 'USAGE'::text), ('app_config'::text, 'CREATE'::text),
           ('platform'::text, 'USAGE'::text), ('platform'::text, 'CREATE'::text),
           ('audit'::text, 'USAGE'::text), ('audit'::text, 'CREATE'::text),
           ('ops'::text, 'USAGE'::text), ('ops'::text, 'CREATE'::text)
  $$,
  'migrator has only the six core schema DDL grants'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
      as privilege(name)
    where relation.relkind in ('r','p','v','m','f')
      and namespace.nspname in ('identity','privacy','app_config','platform','audit','ops')
      and (
        pg_catalog.has_table_privilege('migrator', relation.oid, privilege.name)
        or (privilege.name in ('SELECT','INSERT','UPDATE','REFERENCES')
            and pg_catalog.has_any_column_privilege('migrator', relation.oid, privilege.name))
      )
  ),
  'migrator receives no table privileges'
);

select set_eq(
  $$
    select granted.rolname
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid = membership.roleid
    where membership.member = 'api_runtime'::regrole
  $$,
  $$
    values ('authenticated'::text), ('identity_system'::text),
           ('privacy_system'::text), ('app_config_system'::text),
           ('platform_system'::text)
  $$,
  'api_runtime can assume only the authenticated and four context roles'
);

select ok(
  (select count(*) = 5
      and bool_and(coalesce((to_jsonb(membership)->>'set_option')::boolean, false))
      and bool_and(not coalesce((to_jsonb(membership)->>'inherit_option')::boolean, true))
      and bool_and(not membership.admin_option)
   from pg_catalog.pg_auth_members membership
   where membership.member = 'api_runtime'::regrole),
  'api_runtime memberships are SET-only, non-inheriting, and not delegable'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
      as privilege(name)
    where relation.relkind in ('r','p','v','m','f')
      and namespace.nspname in ('identity','privacy','app_config','platform','audit','ops')
      and (
        pg_catalog.has_table_privilege('api_runtime', relation.oid, privilege.name)
        or (privilege.name in ('SELECT','INSERT','UPDATE','REFERENCES')
            and pg_catalog.has_any_column_privilege('api_runtime', relation.oid, privilege.name))
      )
  ),
  'api_runtime has no table, view, or foreign-table privileges'
);

select ok(
  not exists (select 1 from pg_catalog.pg_class where relowner = 'api_runtime'::regrole)
  and not exists (select 1 from pg_catalog.pg_proc where proowner = 'api_runtime'::regrole)
  and not exists (select 1 from pg_catalog.pg_namespace where nspowner = 'api_runtime'::regrole)
  and not exists (select 1 from pg_catalog.pg_database
                  where datname = current_database() and datdba = 'api_runtime'::regrole)
  and not exists (select 1 from pg_catalog.pg_auth_members
                  where roleid = 'api_runtime'::regrole and (set_option or inherit_option)),
  'api_runtime owns no database objects and has no effective members'
);

select set_eq(
  $$
    select namespace.nspname || '.' || relation.relname
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname in ('identity','privacy','app_config','platform','audit','ops')
      and relation.relkind in ('r','p')
  $$,
  $$
    values ('identity.signup_reservations'::text),
           ('app_config.operator_alert_exempt_keys'::text),
           ('app_config.settings'::text),
           ('audit.events'::text), ('ops.alerts'::text),
           ('platform.idempotency_keys'::text)
  $$,
  'Wave 2 creates exactly its six baseline tables'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where relation.relkind in ('r','p')
      and namespace.nspname in ('identity','privacy','app_config','platform','audit','ops')
      and (not relation.relrowsecurity or not relation.relforcerowsecurity)
  ),
  'every W2 application table has RLS enabled and forced'
);

select set_eq(
  $$
    select role.rolname,
           namespace.nspname || '.' || relation.relname,
           privilege.privilege_type
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) privilege
    join pg_catalog.pg_roles role on role.oid = privilege.grantee
    where namespace.nspname in ('identity','privacy','app_config','platform','audit','ops')
      and relation.relkind in ('r','p')
      and role.rolname in ('anon','authenticated')
  $$,
  $$
    select expected.role_name,
           expected.schema_name || '.' || expected.object_name,
           allowed.privilege_type
    from test_support.expected_grants expected
    cross join lateral unnest(expected.privileges) as allowed(privilege_type)
    where expected.role_name in ('anon','authenticated')
  $$,
  'anon and authenticated table grants match grants-allowlist.json'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) privilege
    where namespace.nspname in ('identity','privacy','app_config','platform','audit','ops')
      and relation.relkind in ('r','p')
      and privilege.grantee = 0
  ),
  'PUBLIC has no table privileges in Wave 2 schemas'
);

select ok(
  not pg_catalog.has_schema_privilege('anon', 'public', 'USAGE')
  and not pg_catalog.has_schema_privilege('authenticated', 'public', 'USAGE')
  and not pg_catalog.has_schema_privilege('anon', 'public', 'CREATE')
  and not pg_catalog.has_schema_privilege('authenticated', 'public', 'CREATE'),
  'public remains unavailable to anon and authenticated'
);

select ok(
  (pg_catalog.to_regclass('storage.buckets') is null
   and pg_catalog.to_regclass('storage.objects') is null)
  or (pg_catalog.to_regclass('storage.buckets') is not null
      and pg_catalog.to_regclass('storage.objects') is not null),
  'a disabled Storage service omits both managed relations rather than a partial surface'
);
select ok(
  not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net'),
  'a fresh W2 baseline does not install pg_net for database-side alert delivery'
);

-- Disabled provider tables are conditional in Supabase CLI snapshots. When
-- present, create fixtures as the setup administrator and exercise their
-- actual role-facing SELECT and INSERT paths below.
do $$
begin
  if pg_catalog.to_regclass('storage.buckets') is not null
     and pg_catalog.to_regclass('storage.objects') is not null then
    execute $query$
      insert into storage.buckets (id, name, public)
      values ('w2-pgtap-private', 'w2-pgtap-private', false)
    $query$;
    execute $query$
      insert into storage.objects (bucket_id, name, owner_id, metadata)
      values ('w2-pgtap-private', 'fixture.txt',
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"mimetype":"text/plain"}')
    $query$;
  end if;
  if pg_catalog.to_regclass('realtime.messages') is not null then
    execute $query$
      insert into realtime.messages (topic, extension, private, event, payload)
      values ('w2-pgtap-private-topic', 'broadcast', true, 'INSERT', '{"fixture":true}')
    $query$;
  end if;
end;
$$;

select ok(
  test_support.private_storage_fixture_count() is null
  or test_support.private_storage_fixture_count() = 1,
  'Storage has an actual private-object fixture when relations exist; NULL means the disabled service omitted them and RLS was not exercised'
);
select ok(
  test_support.private_realtime_fixture_count() is null
  or test_support.private_realtime_fixture_count() = 1,
  'Realtime has an actual private-message fixture when its relation exists; NULL means it is disabled and RLS was not exercised'
);
select set_config('test.storage_objects_rls',
  coalesce((select relation.relrowsecurity::text
            from pg_catalog.pg_class relation
            where relation.oid = pg_catalog.to_regclass('storage.objects')), 'absent'), true);
select set_config('test.realtime_messages_rls',
  coalesce((select relation.relrowsecurity::text
            from pg_catalog.pg_class relation
            where relation.oid = pg_catalog.to_regclass('realtime.messages')), 'absent'), true);

set local role anon;
select ok(
  test_support.private_storage_fixture_count() is null
  or test_support.private_storage_fixture_count() = -1
  or (test_support.private_storage_fixture_count() = 0
      and current_setting('test.storage_objects_rls', true) = 'true'),
  'anon reads no private Storage fixture: zero means RLS filtered it, -1 means ACL denial, NULL means relation absent'
);
select ok(
  test_support.private_storage_fixture_insert_denied() is distinct from false,
  'anon cannot write a private Storage fixture; NULL means no managed table is available'
);
select ok(
  test_support.private_realtime_fixture_count() is null
  or test_support.private_realtime_fixture_count() = -1
  or (test_support.private_realtime_fixture_count() = 0
      and current_setting('test.realtime_messages_rls', true) = 'true'),
  'anon reads no private Realtime fixture: zero means RLS filtered it, -1 means ACL denial, NULL means relation absent'
);
select ok(
  test_support.private_realtime_fixture_insert_denied() is distinct from false,
  'anon cannot write a private Realtime fixture; NULL means no managed table is available'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', true);
select set_config('test.storage_owner_count',
  coalesce(test_support.private_storage_fixture_count()::text, 'absent'), true);
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}', true);
select ok(
  case current_setting('test.storage_owner_count', true)
    when 'absent' then test_support.private_storage_fixture_count() is null
    when '-1' then test_support.private_storage_fixture_count() = -1
    when '0' then test_support.private_storage_fixture_count() <= 0
    when '1' then test_support.private_storage_fixture_count() = 0
      and current_setting('test.storage_objects_rls', true) = 'true'
    else false
  end,
  'when Storage grants owner reads, another user cannot read the fixture; otherwise the access boundary denies both'
);
select ok(
  test_support.private_storage_fixture_insert_denied() is distinct from false,
  'authenticated cannot write a private Storage fixture; NULL means no managed table is available'
);
select ok(
  test_support.private_realtime_fixture_count() is null
  or test_support.private_realtime_fixture_count() = -1
  or (test_support.private_realtime_fixture_count() = 0
      and current_setting('test.realtime_messages_rls', true) = 'true'),
  'authenticated reads no private Realtime fixture: zero means RLS filtered it, -1 means ACL denial, NULL means relation absent'
);
select ok(
  test_support.private_realtime_fixture_insert_denied() is distinct from false,
  'authenticated cannot write a private Realtime fixture; NULL means no managed table is available'
);
reset role;

select set_eq(
  $$
    select role.rolname,
           namespace.nspname || '.' || relation.relname,
           privilege.privilege_type
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) privilege
    join pg_catalog.pg_roles role on role.oid = privilege.grantee
    where relation.relkind in ('r','p')
      and namespace.nspname in ('identity','privacy','app_config','platform','audit','ops')
      and role.rolname in (
        'identity_system','privacy_system','app_config_system','platform_system'
      )
  $$,
  $$
    values ('identity_system'::text, 'audit.events'::text, 'INSERT'::text),
           ('privacy_system'::text, 'audit.events'::text, 'INSERT'::text),
           ('app_config_system'::text, 'app_config.settings'::text, 'SELECT'::text),
           ('app_config_system'::text, 'app_config.operator_alert_exempt_keys'::text, 'SELECT'::text),
           ('app_config_system'::text, 'audit.events'::text, 'INSERT'::text),
           ('platform_system'::text, 'platform.idempotency_keys'::text, 'SELECT'::text),
           ('platform_system'::text, 'platform.idempotency_keys'::text, 'INSERT'::text),
           ('platform_system'::text, 'platform.idempotency_keys'::text, 'UPDATE'::text),
           ('platform_system'::text, 'platform.idempotency_keys'::text, 'DELETE'::text),
           ('platform_system'::text, 'audit.events'::text, 'INSERT'::text)
  $$,
  'context roles have only their table grants and the documented audit insert'
);

select set_eq(
  $$
    select namespace.nspname || '.' || relation.relname, owner.rolname
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_catalog.pg_roles owner on owner.oid = relation.relowner
    where namespace.nspname in ('identity','app_config','platform','audit','ops')
      and relation.relkind in ('r','p')
  $$,
  $$
    values ('identity.signup_reservations'::text, 'postgres'::text),
           ('app_config.settings'::text, 'postgres'::text),
           ('app_config.operator_alert_exempt_keys'::text, 'postgres'::text),
           ('platform.idempotency_keys'::text, 'postgres'::text),
           ('audit.events'::text, 'postgres'::text),
           ('ops.alerts'::text, 'postgres'::text)
  $$,
  'all six application tables remain owned by the migration role'
);

select set_eq(
  $$
    select role.rolname, namespace.nspname || '.' || relation.relname,
           privilege.privilege_type
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) privilege
    join pg_catalog.pg_roles role on role.oid = privilege.grantee
    where namespace.nspname in ('identity','app_config','platform','audit','ops')
      and relation.relkind in ('r','p')
      and role.rolname in ('ops','app_config_admin')
  $$,
  $$
    values ('app_config_admin'::text, 'app_config.settings'::text, 'SELECT'::text),
           ('app_config_admin'::text, 'app_config.settings'::text, 'INSERT'::text),
           ('app_config_admin'::text, 'app_config.settings'::text, 'UPDATE'::text),
           ('ops'::text, 'app_config.operator_alert_exempt_keys'::text, 'SELECT'::text),
           ('ops'::text, 'audit.events'::text, 'INSERT'::text),
           ('ops'::text, 'audit.events'::text, 'DELETE'::text),
           ('ops'::text, 'ops.alerts'::text, 'SELECT'::text),
           ('ops'::text, 'ops.alerts'::text, 'INSERT'::text),
           ('ops'::text, 'ops.alerts'::text, 'UPDATE'::text),
           ('ops'::text, 'platform.idempotency_keys'::text, 'DELETE'::text)
  $$,
  'ops and app_config_admin have only their direct application-table grants'
);

select set_eq(
  $$
    select namespace.nspname || '.' || relation.relname, attribute.attname,
           privilege.privilege_type
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
    where namespace.nspname in ('audit','platform')
      and attribute.attnum > 0 and not attribute.attisdropped
      and privilege.grantee = 'ops'::regrole
  $$,
  $$
    values ('audit.events'::text, 'action'::text, 'SELECT'::text),
           ('audit.events'::text, 'actor_type'::text, 'SELECT'::text),
           ('audit.events'::text, 'id'::text, 'SELECT'::text),
           ('audit.events'::text, 'occurred_at'::text, 'SELECT'::text),
           ('audit.events'::text, 'resource_ref'::text, 'SELECT'::text),
           ('audit.events'::text, 'resource_type'::text, 'SELECT'::text),
           ('platform.idempotency_keys'::text, 'expires_at'::text, 'SELECT'::text),
           ('platform.idempotency_keys'::text, 'key'::text, 'SELECT'::text),
           ('platform.idempotency_keys'::text, 'user_id'::text, 'SELECT'::text)
  $$,
  'ops has only the declared audit and idempotency key-column reads'
);

select set_eq(
  $$
    select member.rolname
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles member on member.oid = membership.member
    where membership.roleid = 'audit_writer'::regrole
      and (membership.set_option or membership.inherit_option)
  $$,
  $$
    select member_name from test_support.expected_group_members
    where group_name = 'audit_writer'
  $$,
  'audit_writer membership matches the core and extension registry fixtures'
);

select set_eq(
  $$
    select member.rolname
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles member on member.oid = membership.member
    where membership.roleid = 'audit_operator_writer'::regrole
      and (membership.set_option or membership.inherit_option)
  $$,
  $$
    select member_name from test_support.expected_group_members
    where group_name = 'audit_operator_writer'
  $$,
  'audit_operator_writer membership matches the core and extension registry fixtures'
);

select set_eq(
  $$
    select member.rolname
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles member on member.oid = membership.member
    where membership.roleid = 'audit_reader'::regrole
      and (membership.set_option or membership.inherit_option)
  $$,
  $$
    select member_name from test_support.expected_group_members
    where group_name = 'audit_reader'
  $$,
  'audit_reader membership matches the core and extension registry fixtures'
);

select set_eq(
  $$
    select member.rolname
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles member on member.oid = membership.member
    where membership.roleid = 'app_config_writer'::regrole
      and (membership.set_option or membership.inherit_option)
  $$,
  $$
    select member_name from test_support.expected_group_members
    where group_name = 'app_config_writer'
  $$,
  'app_config_writer membership matches the core and extension registry fixtures'
);

select ok(
  not exists (select 1 from pg_catalog.pg_roles where rolname = 'auth_fn_owner'),
  'the unsupported auth_fn_owner role is absent from the closed core baseline'
);

select set_eq(
  $$
    select registry.schema_name || '.' || registry.function_name || registry.signature
           || ':' || registry.owner_name || ':'
           || array_to_string(registry.execute_callers, ',') || ':' || registry.migration
    from test_support.expected_core_auth_fn_registry registry
  $$,
  $$
    values
      ('identity.before_user_created(jsonb):postgres:supabase_auth_admin:20261125175958_w2_supabase_compatibility_baseline.sql'::text),
      ('identity.count_unconfirmed_users():postgres:ops:20261125175958_w2_supabase_compatibility_baseline.sql'::text),
      ('identity.delete_unconfirmed_users():postgres:ops:20261125175958_w2_supabase_compatibility_baseline.sql'::text)
  $$,
  'the core Auth registry is closed to the three approved W2 functions and callers'
);

select set_eq(
  $$
    select namespace.nspname || '.' || procedure.proname || '('
           || coalesce(array_to_string(procedure.proargtypes::regtype[], ','), '') || ')'
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'identity'
      and procedure.proowner = 'postgres'::regrole
  $$,
  $$
    select registry.schema_name || '.' || registry.function_name || registry.signature
    from test_support.expected_core_auth_fn_registry registry
  $$,
  'postgres owns exactly the registered Auth functions in identity'
);

select set_eq(
  $$
    select procedure.proname || ':' || pg_catalog.pg_get_function_result(procedure.oid)
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'identity'
      and procedure.proowner = 'postgres'::regrole
  $$,
  $$
    values ('before_user_created:jsonb'::text),
           ('count_unconfirmed_users:bigint'::text),
           ('delete_unconfirmed_users:integer'::text)
  $$,
  'the three Auth helpers keep their exact return types'
);

select ok(
  not exists (
    select 1
    from test_support.expected_core_auth_fn_registry registry
    join pg_catalog.pg_namespace namespace on namespace.nspname = registry.schema_name
    join pg_catalog.pg_proc procedure
      on procedure.pronamespace = namespace.oid
     and procedure.proname = registry.function_name
     and procedure.proargtypes::regtype[] = string_to_array(
       trim(both '()' from registry.signature), ',')::regtype[]
    where procedure.proowner <> 'postgres'::regrole
       or not procedure.prosecdef
       or not coalesce('search_path=""' = any(procedure.proconfig), false)
  ),
  'every registered Auth helper is postgres-owned, SECURITY DEFINER, and search-path isolated'
);

select set_eq(
  $$
    select namespace.nspname || '.' || procedure.proname || '('
           || coalesce(array_to_string(procedure.proargtypes::regtype[], ','), '') || ')',
           case when privilege.grantee = 0 then 'PUBLIC' else role.rolname end,
           privilege.privilege_type, privilege.is_grantable
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) privilege
    left join pg_catalog.pg_roles role on role.oid = privilege.grantee
    where namespace.nspname = 'identity'
      and procedure.proowner = 'postgres'::regrole
      and privilege.grantee <> procedure.proowner
  $$,
  $$
    values
      ('identity.before_user_created(jsonb)'::text, 'supabase_auth_admin'::text, 'EXECUTE'::text, false),
      ('identity.count_unconfirmed_users()'::text, 'ops'::text, 'EXECUTE'::text, false),
      ('identity.delete_unconfirmed_users()'::text, 'ops'::text, 'EXECUTE'::text, false)
  $$,
  'Auth helper execution ACLs contain only the registered callers'
);

select ok(
  has_function_privilege('supabase_auth_admin',
    'identity.before_user_created(jsonb)', 'EXECUTE')
  and not has_function_privilege('ops',
    'identity.before_user_created(jsonb)', 'EXECUTE')
  and not has_function_privilege('api_runtime',
    'identity.before_user_created(jsonb)', 'EXECUTE')
  and has_function_privilege('ops', 'identity.count_unconfirmed_users()', 'EXECUTE')
  and has_function_privilege('ops', 'identity.delete_unconfirmed_users()', 'EXECUTE')
  and not has_function_privilege('supabase_auth_admin',
    'identity.count_unconfirmed_users()', 'EXECUTE')
  and not has_function_privilege('supabase_auth_admin',
    'identity.delete_unconfirmed_users()', 'EXECUTE')
  and not has_function_privilege('api_runtime',
    'identity.count_unconfirmed_users()', 'EXECUTE')
  and not has_function_privilege('api_runtime',
    'identity.delete_unconfirmed_users()', 'EXECUTE'),
  'each Auth helper is executable only by its designated non-owner caller'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join (values
      ('anon'::text), ('authenticated'::text), ('api_runtime'::text), ('migrator'::text),
      ('identity_system'::text), ('privacy_system'::text), ('app_config_system'::text),
      ('platform_system'::text), ('ops'::text), ('app_config_admin'::text),
      ('app_config_writer'::text), ('audit_writer'::text),
      ('audit_operator_writer'::text), ('audit_reader'::text)
    ) role_name(name)
    cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
      as privilege(name)
    where namespace.nspname = 'auth'
      and relation.relkind in ('r','p')
      and (
        pg_catalog.has_table_privilege(role_name.name, relation.oid, privilege.name)
        or (privilege.name in ('SELECT','INSERT','UPDATE','REFERENCES')
            and pg_catalog.has_any_column_privilege(role_name.name, relation.oid, privilege.name))
      )
  ),
  'custom app roles have no direct table privileges on managed Auth tables'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_auth_members membership
    where membership.roleid in ('app_config_admin'::regrole, 'ops'::regrole)
      and membership.member = 'postgres'::regrole
      and (membership.set_option or membership.inherit_option)
  ),
  'temporary ownership-transfer memberships are removed after migrations'
);
select ok(
  not has_schema_privilege('app_config_admin', 'app_config', 'CREATE')
  and not has_schema_privilege('ops', 'ops', 'CREATE'),
  'function owners retain no temporary schema CREATE privilege'
);

select * from finish();
rollback;
