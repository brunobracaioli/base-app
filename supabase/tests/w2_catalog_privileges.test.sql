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
  (select count(*) = 12
      and bool_and(not rolcanlogin and not rolsuper and not rolcreatedb
                   and not rolcreaterole and not rolreplication and not rolbypassrls)
   from pg_catalog.pg_roles
   where rolname = any (array[
     'migrator', 'identity_system', 'privacy_system', 'app_config_system', 'platform_system',
     'ops', 'auth_fn_owner', 'app_config_admin', 'audit_writer',
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
    where privilege.grantee = 'migrator'::regrole
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
      and namespace.nspname <> 'information_schema'
      and namespace.nspname not like 'pg_%'
      and pg_catalog.has_table_privilege('migrator', relation.oid, privilege.name)
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
      and namespace.nspname not like 'pg_%'
      and namespace.nspname not in ('information_schema')
      and pg_catalog.has_table_privilege('api_runtime', relation.oid, privilege.name)
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
    values ('app_config.operator_alert_exempt_keys'::text),
           ('app_config.settings'::text),
           ('audit.events'::text), ('ops.alerts'::text),
           ('platform.idempotency_keys'::text)
  $$,
  'Wave 2 creates only its five baseline tables'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where relation.relkind in ('r','p')
      and namespace.nspname not in (
        'auth','storage','realtime','vault','cron','net','extensions','information_schema',
        'test_support'
      )
      and namespace.nspname not like 'pg_%'
      and namespace.nspname not like 'supabase_%'
      and (not relation.relrowsecurity or not relation.relforcerowsecurity)
  ),
  'every non-system table has RLS enabled and forced'
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
  exists (select 1 from pg_catalog.pg_namespace where nspname = 'storage')
  and exists (select 1 from pg_catalog.pg_namespace where nspname = 'realtime'),
  'Storage and Realtime schemas are present for privilege checks'
);

select ok(
  not exists (
    select 1 from pg_catalog.pg_namespace namespace
    cross join (values ('anon'::text), ('authenticated'::text)) roles(role_name)
    where namespace.nspname in ('storage','realtime')
      and (pg_catalog.has_schema_privilege(roles.role_name, namespace.oid, 'USAGE')
           or pg_catalog.has_schema_privilege(roles.role_name, namespace.oid, 'CREATE'))
  ),
  'anon and authenticated have no schema privileges in Storage or Realtime'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join (values ('anon'::text), ('authenticated'::text)) roles(role_name)
    cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
      as privilege(name)
    where namespace.nspname in ('storage','realtime')
      and relation.relkind in ('r','p','v','m','f')
      and pg_catalog.has_table_privilege(roles.role_name, relation.oid, privilege.name)
  ),
  'anon and authenticated have no table privileges in Storage or Realtime'
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

select set_eq(
  $$
    select relation.relname, privilege.privilege_type, privilege.is_grantable
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) privilege
    where namespace.nspname = 'auth'
      and relation.relkind in ('r','p')
      and privilege.grantee = 'auth_fn_owner'::regrole
  $$,
  $$
    values ('users'::text, 'SELECT'::text, false),
           ('users'::text, 'DELETE'::text, false),
           ('sessions'::text, 'SELECT'::text, false),
           ('sessions'::text, 'DELETE'::text, false),
           ('refresh_tokens'::text, 'SELECT'::text, false),
           ('refresh_tokens'::text, 'DELETE'::text, false),
           ('identities'::text, 'SELECT'::text, false),
           ('identities'::text, 'DELETE'::text, false),
           ('audit_log_entries'::text, 'DELETE'::text, false),
           ('flow_state'::text, 'DELETE'::text, false)
  $$,
  'auth_fn_owner has exactly the fixed auth table grants'
);

select set_eq(
  $$
    select namespace.nspname || '.' || relation.relname,
           attribute.attname, privilege.privilege_type, privilege.is_grantable
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
    where namespace.nspname = 'auth'
      and relation.relkind in ('r','p')
      and attribute.attnum > 0 and not attribute.attisdropped
      and privilege.grantee = 'auth_fn_owner'::regrole
  $$,
  $$
    values ('auth.users'::text, 'banned_until'::text, 'UPDATE'::text, false),
           ('auth.users'::text, 'encrypted_password'::text, 'UPDATE'::text, false),
           ('auth.users'::text, 'raw_app_meta_data'::text, 'UPDATE'::text, false)
  $$,
  'auth_fn_owner has only the three specified auth.users column updates'
);

select ok(
  pg_catalog.has_schema_privilege('auth_fn_owner', 'auth', 'USAGE')
  and not pg_catalog.has_schema_privilege('auth_fn_owner', 'auth', 'CREATE'),
  'auth_fn_owner can use but cannot create in auth'
);

select ok(
  not exists (
    select 1 from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) privilege
    where namespace.nspname <> 'auth'
      and relation.relkind in ('r','p','v','m','f')
      and privilege.grantee = 'auth_fn_owner'::regrole
  )
  and not exists (
    select 1 from pg_catalog.pg_namespace namespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
    ) privilege
    where namespace.nspname <> 'auth'
      and privilege.grantee = 'auth_fn_owner'::regrole
  )
  and not exists (
    select 1 from pg_catalog.pg_auth_members
    where roleid = 'auth_fn_owner'::regrole and (set_option or inherit_option)
  ),
  'auth_fn_owner receives no table/schema grants elsewhere and has no effective members'
);

select set_eq(
  $$
    select procedure.oid::regprocedure::text
    from pg_catalog.pg_proc procedure
    where procedure.proowner = 'auth_fn_owner'::regrole
  $$,
  $$
    select registry.schema_name || '.' || registry.function_name || registry.signature
    from test_support.expected_auth_fn_registry registry
  $$,
  'auth_fn_owner owns exactly the functions listed in auth-fn-registry.d'
);

select ok(
  exists (
    select 1 from pg_catalog.pg_proc procedure
    where procedure.oid = pg_catalog.to_regprocedure('identity.before_user_created(jsonb)')
      and procedure.proowner = 'auth_fn_owner'::regrole
      and procedure.prosecdef
      and 'search_path=""' = any(procedure.proconfig)
  ),
  'before_user_created is SECURITY DEFINER with an empty search_path'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc procedure
    cross join lateral pg_catalog.aclexplode(
      coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) privilege
    where procedure.proowner = 'auth_fn_owner'::regrole
      and privilege.grantee in (
        0, 'anon'::regrole, 'authenticated'::regrole, 'api_runtime'::regrole,
        'identity_system'::regrole, 'privacy_system'::regrole,
        'app_config_system'::regrole, 'platform_system'::regrole
      )
      and privilege.privilege_type = 'EXECUTE'
  ),
  'auth_fn_owner functions are not executable through public or runtime roles'
);

select set_eq(
  $$
    select procedure.oid::regprocedure::text, role.rolname,
           privilege.privilege_type, privilege.is_grantable
    from pg_catalog.pg_proc procedure
    cross join lateral pg_catalog.aclexplode(
      coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) privilege
    join pg_catalog.pg_roles role on role.oid = privilege.grantee
    where procedure.proowner = 'auth_fn_owner'::regrole
  $$,
  $$
    values (
      pg_catalog.to_regprocedure('identity.before_user_created(jsonb)')::regprocedure::text,
      'auth_fn_owner'::text, 'EXECUTE'::text, false
    ),
    (
      pg_catalog.to_regprocedure('identity.before_user_created(jsonb)')::regprocedure::text,
      'supabase_auth_admin'::text, 'EXECUTE'::text, false
    )
  $$,
  'auth_fn_owner function execution is granted only to the owner and Auth hook role'
);

select ok(
  not exists (
    select 1 from pg_catalog.pg_auth_members membership
    where membership.roleid in ('app_config_admin'::regrole, 'auth_fn_owner'::regrole, 'ops'::regrole)
      and membership.member = 'postgres'::regrole
      and (membership.set_option or membership.inherit_option)
  ),
  'temporary ownership-transfer memberships are removed after migrations'
);
select ok(
  not has_schema_privilege('app_config_admin', 'app_config', 'CREATE')
  and not has_schema_privilege('auth_fn_owner', 'identity', 'CREATE')
  and not has_schema_privilege('ops', 'ops', 'CREATE'),
  'function owners retain no temporary schema CREATE privilege'
);

select * from finish();
rollback;
