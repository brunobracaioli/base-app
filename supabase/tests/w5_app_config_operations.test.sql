begin;
set local search_path = test_support, extensions, public;
select no_plan();

select ok(
  (select not rolcanlogin and not rolinherit and not rolsuper and not rolcreatedb
          and not rolcreaterole and not rolreplication and not rolbypassrls
   from pg_catalog.pg_roles where rolname = 'app_config_history_reader'),
  'the rollback history owner is a least-privilege NOLOGIN role'
);
select ok(
  not pg_catalog.has_table_privilege('app_config_history_reader', 'audit.events', 'SELECT')
  and pg_catalog.has_column_privilege(
    'app_config_history_reader', 'audit.events', 'metadata', 'SELECT'
  )
  and not pg_catalog.has_column_privilege(
    'app_config_history_reader', 'audit.events', 'actor_ref', 'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'app_config_history_reader', 'app_config.settings', 'SELECT'
  )
  and not pg_catalog.has_schema_privilege('app_config_history_reader', 'ops', 'USAGE')
  and not pg_catalog.has_function_privilege(
    'app_config_history_reader', 'ops.app_config_change_count_last_hour()', 'EXECUTE'
  )
  and not pg_catalog.pg_has_role('app_config_history_reader', 'ops', 'MEMBER')
  and not pg_catalog.pg_has_role('app_config_history_reader', 'app_config_writer', 'MEMBER')
  and not pg_catalog.pg_has_role('app_config_history_reader', 'audit_reader', 'MEMBER'),
  'the history reader has only the narrow audit-column and RLS-backed capability'
);
select set_eq(
  $$
    select attribute.attname, privilege.privilege_type
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
    where namespace.nspname = 'audit'
      and relation.relname = 'events'
      and attribute.attnum > 0 and not attribute.attisdropped
      and privilege.grantee = 'app_config_history_reader'::regrole
  $$,
  $$
    values ('action'::text, 'SELECT'::text),
           ('id'::text, 'SELECT'::text),
           ('metadata'::text, 'SELECT'::text),
           ('occurred_at'::text, 'SELECT'::text),
           ('outcome'::text, 'SELECT'::text),
           ('resource_ref'::text, 'SELECT'::text),
           ('resource_type'::text, 'SELECT'::text)
  $$,
  'history access is limited to exactly the rollback reader columns'
);

select ok(
  exists (
    select 1 from pg_catalog.pg_proc procedure
    where procedure.oid = pg_catalog.to_regprocedure(
      'app_config.read_setting(text)'
    )
      and procedure.proowner = 'app_config_admin'::regrole
      and procedure.prosecdef
      and 'search_path=""' = any(procedure.proconfig)
  )
  and exists (
    select 1 from pg_catalog.pg_proc procedure
    where procedure.oid = pg_catalog.to_regprocedure(
      'app_config.read_rollback_setting(text)'
    )
      and procedure.proowner = 'app_config_history_reader'::regrole
      and procedure.prosecdef
      and 'search_path=""' = any(procedure.proconfig)
  ),
  'both readers are fixed SECURITY DEFINER functions with their exact owners'
);
select ok(
  exists (
    select 1 from pg_catalog.pg_proc procedure
    where procedure.oid = pg_catalog.to_regprocedure(
      'app_config.set_setting(text,jsonb,text,text,text,timestamptz)'
    )
      and procedure.proowner = 'app_config_admin'::regrole
      and procedure.prosecdef
      and 'search_path=""' = any(procedure.proconfig)
  )
  and exists (
    select 1 from pg_catalog.pg_proc procedure
    where procedure.oid = pg_catalog.to_regprocedure(
      'app_config.set_setting(text,jsonb,text,text,text,timestamptz,boolean)'
    )
      and procedure.proowner = 'app_config_admin'::regrole
      and procedure.prosecdef
      and 'search_path=""' = any(procedure.proconfig)
  ),
  'the six- and seven-argument setters retain the exact owner and security boundary'
);
select ok(
  has_function_privilege(
    'app_config_writer',
    'app_config.set_setting(text,jsonb,text,text,text,timestamptz)', 'EXECUTE'
  )
  and has_function_privilege(
    'app_config_writer',
    'app_config.set_setting(text,jsonb,text,text,text,timestamptz,boolean)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'app_config.set_setting(text,jsonb,text,text,text,timestamptz,boolean)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'app_config.set_setting(text,jsonb,text,text,text,timestamptz,boolean)', 'EXECUTE'
  ),
  'both setters are executable only through app_config_writer and their owner'
);
select ok(
  has_function_privilege('app_config_writer', 'app_config.read_setting(text)', 'EXECUTE')
  and has_function_privilege(
    'app_config_admin', 'app_config.read_setting(text)', 'EXECUTE'
  )
  and has_function_privilege(
    'app_config_writer', 'app_config.read_rollback_setting(text)', 'EXECUTE'
  )
  and has_function_privilege(
    'app_config_history_reader', 'app_config.read_rollback_setting(text)', 'EXECUTE'
  )
  and not has_function_privilege(
    'app_config_admin', 'app_config.read_rollback_setting(text)', 'EXECUTE'
  )
  and not has_function_privilege(
    'app_config_history_reader', 'app_config.read_setting(text)', 'EXECUTE'
  )
  and not has_function_privilege(
    'api_runtime', 'app_config.read_setting(text)', 'EXECUTE'
  )
  and not has_function_privilege(
    'service_role', 'app_config.read_rollback_setting(text)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'app_config.read_setting(text)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'app_config.read_rollback_setting(text)', 'EXECUTE'
  ),
  'each reader EXECUTE grant is limited to app_config_writer and its function owner'
);
select ok(
  not has_table_privilege('service_role', 'audit.events', 'INSERT'),
  'the RLS-bypassing service role has no audit INSERT privilege'
);

select set_config('test.maintenance_value',
  (select value::text from app_config.settings where key = 'maintenance'), true);
select set_config('test.maintenance_updated_at',
  (select updated_at::text from app_config.settings where key = 'maintenance'), true);
select is(
  has_table_privilege('app_config_writer', 'app_config.settings', 'SELECT'),
  false,
  'the writer has no direct SELECT on settings'
);
set local role app_config_writer;
select is(
  (select value::text from app_config.read_setting('maintenance')),
  current_setting('test.maintenance_value', true),
  'the writer reads one allowlisted setting through read_setting'
);
select is(
  (select updated_at::text from app_config.read_setting('maintenance')),
  current_setting('test.maintenance_updated_at', true),
  'read_setting returns the exact CAS timestamp'
);
select is(
  (select count(*)::integer from app_config.read_setting('not-a-setting')),
  0,
  'read_setting returns no row for a key outside the allowlist'
);
select is(
  (select count(*)::integer from app_config.read_rollback_setting('not-a-setting')),
  0,
  'read_rollback_setting returns no row for a key outside the allowlist'
);
select throws_ok('select * from audit.events', '42501', null,
  'the writer cannot read the audit table directly');
reset role;

-- Controlled postgres-only fixture rows; the enclosing test transaction rolls them back.
set local role postgres;
insert into audit.events (id, occurred_at, actor_type, actor_ref, action, resource_type,
                          resource_ref, outcome, correlation_id, metadata)
values
  ('11111111-1111-4111-8111-111111111101', now() - interval '10 minutes',
   'system', 'script:app-config:older', 'app_config.updated', 'app_config.settings',
   'maintenance', 'success', 'w5-history-older',
   '{"before":{"active":false},"after":{"active":true}}'::jsonb),
  ('11111111-1111-4111-8111-111111111102', now() - interval '5 minutes',
   'system', 'script:app-config:tie-low', 'app_config.updated', 'app_config.settings',
   'maintenance', 'success', 'w5-history-tie-low',
   '{"before":{"active":true},"after":{"active":false}}'::jsonb),
  ('11111111-1111-4111-8111-111111111103', now() - interval '5 minutes',
   'operator', '11111111-1111-4111-8111-111111111111', 'app_config.updated',
   'app_config.settings', 'maintenance', 'success', 'w5-history-tie-high',
   '{"before":{"active":false},"after":{"active":true}}'::jsonb),
  ('11111111-1111-4111-8111-111111111104', now() - interval '1 minute',
   'system', 'script:app-config:failed', 'app_config.updated', 'app_config.settings',
   'maintenance', 'failed', 'w5-history-failed',
   '{"before":{"active":true},"after":{"active":false}}'::jsonb),
  ('11111111-1111-4111-8111-111111111105', now() - interval '1 minute',
   'system', 'script:app-config:wrong-action', 'app_config.changed',
   'app_config.settings', 'maintenance', 'success', 'w5-history-wrong-action',
   '{"before":{"active":true},"after":{"active":false}}'::jsonb),
  ('11111111-1111-4111-8111-111111111106', now() - interval '1 minute',
   'system', 'script:app-config:wrong-resource', 'app_config.updated', 'other',
   'maintenance', 'success', 'w5-history-wrong-resource',
   '{"before":{"active":true},"after":{"active":false}}'::jsonb),
  ('11111111-1111-4111-8111-111111111107', now() - interval '1 minute',
   'webhook', null, 'app_config.updated', 'app_config.settings',
   'maintenance', 'success', 'w5-history-wrong-actor',
   '{"before":{"active":true},"after":{"active":false}}'::jsonb);
reset role;

set local role app_config_history_reader;
select set_eq(
  $$
    select id::text, action, resource_ref, outcome
    from audit.events
    where resource_ref = 'maintenance'
  $$,
  $$
    values ('11111111-1111-4111-8111-111111111101'::text,
            'app_config.updated'::text, 'maintenance'::text, 'success'::text),
           ('11111111-1111-4111-8111-111111111102'::text,
            'app_config.updated'::text, 'maintenance'::text, 'success'::text),
           ('11111111-1111-4111-8111-111111111103'::text,
            'app_config.updated'::text, 'maintenance'::text, 'success'::text)
  $$,
  'history RLS exposes only successful settings events from system or operator actors'
);
select throws_ok('select actor_ref from audit.events', '42501', null,
  'the history owner cannot read ungranted audit columns');
select throws_ok('select * from app_config.settings', '42501', null,
  'the history owner cannot read app_config settings directly');
reset role;

set local role app_config_writer;
select is(
  (select event_id::text from app_config.read_rollback_setting('maintenance')),
  '11111111-1111-4111-8111-111111111103',
  'rollback history uses occurred_at and event id to break ties'
);
select is(
  (select before_value from app_config.read_rollback_setting('maintenance')),
  '{"active":false}'::jsonb,
  'rollback history returns the last successful before value'
);
select is(
  (select after_value from app_config.read_rollback_setting('maintenance')),
  '{"active":true}'::jsonb,
  'rollback history returns the last successful after value'
);
reset role;

select set_config('test.maintenance_updated_at_before_w5',
  (select updated_at::text from app_config.settings where key = 'maintenance'), true);
set local role app_config_writer;
select lives_ok($sql$
  select app_config.set_setting(
    'maintenance', '{"active":true}'::jsonb, 'system',
    'script:app-config:pgtap', 'w5-six-argument-compat',
    current_setting('test.maintenance_updated_at_before_w5', true)::timestamptz
  )
$sql$, 'the existing six-argument setter remains compatible and records force=false');
reset role;
select is(
  (select metadata -> 'force' from audit.events
   where correlation_id = 'w5-six-argument-compat'),
  'false'::jsonb,
  'the compatibility setter explicitly audits force=false'
);
set local role app_config_writer;
select is(
  (select after_value from app_config.read_rollback_setting('maintenance')),
  '{"active":true}'::jsonb,
  'the writer can retrieve its own setting rollback through the key-scoped reader'
);
select is(
  (select before_value from app_config.read_rollback_setting('maintenance')),
  current_setting('test.maintenance_value', true)::jsonb,
  'rollback of the compatibility setter retains the before value'
);
reset role;

select set_config('test.legal_updated_at_before_w5',
  (select updated_at::text from app_config.settings where key = 'legal'), true);
set local role app_config_writer;
select lives_ok($sql$
  select app_config.set_setting(
    'legal', '{"termsVersion":"2026-02-01","privacyVersion":"2026-01-01"}'::jsonb,
    'system', 'script:app-config:pgtap', 'w5-seven-argument-force',
    current_setting('test.legal_updated_at_before_w5', true)::timestamptz, true
  )
$sql$, 'the seven-argument setter accepts and records force=true');
reset role;
select is(
  (select metadata -> 'force' from audit.events
   where correlation_id = 'w5-seven-argument-force'),
  'true'::jsonb,
  'the seven-argument setter audits force=true'
);
set local role app_config_writer;
select is(
  (select after_value from app_config.read_rollback_setting('legal')),
  '{"termsVersion":"2026-02-01","privacyVersion":"2026-01-01"}'::jsonb,
  'the writer can retrieve the forced setting rollback through the key-scoped reader'
);
reset role;

select set_config('test.maintenance_updated_at_after_w5',
  (select updated_at::text from app_config.settings where key = 'maintenance'), true);
set local role app_config_writer;
select throws_ok($sql$
  select app_config.set_setting(
    'maintenance', '{"active":false}'::jsonb, 'system',
    'script:app-config:pgtap', 'w5-stale-cas',
    current_setting('test.maintenance_updated_at_before_w5', true)::timestamptz, false
  )
$sql$, 'AC409', null, 'the seven-argument setter preserves stale CAS conflicts');
select throws_ok($sql$
  select app_config.set_setting(
    'maintenance', '{"active":false}'::jsonb, 'system',
    'script:app-config:pgtap', 'w5-null-cas', null, true
  )
$sql$, 'AC409', null, 'null expected timestamp still conflicts with an existing key');
reset role;
select is(
  (select count(*)::integer from audit.events
   where correlation_id in ('w5-stale-cas', 'w5-null-cas')),
  0,
  'CAS conflicts do not create audit history'
);

select set_config('test.maintenance_updated_at_before_audit_failure',
  (select updated_at::text from app_config.settings where key = 'maintenance'), true);
set local role app_config_writer;
select throws_ok($sql$
  select app_config.set_setting(
    'maintenance', '{"active":false}'::jsonb, 'system',
    'script:app-config:pgtap', null,
    current_setting('test.maintenance_updated_at_before_audit_failure', true)::timestamptz,
    true
  )
$sql$, '23502', null, 'an audit insert error aborts the setting write');
reset role;
select is(
  (select value from app_config.settings where key = 'maintenance'),
  '{"active":true}'::jsonb,
  'audit failure rolls the setting mutation back atomically'
);
select is(
  (select count(*)::integer from audit.events where correlation_id is null),
  0,
  'audit failure leaves no partial event'
);

-- Every permissive audit INSERT route must fail closed on this reserved action.
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('user', '11111111-1111-4111-8111-111111111111', 'app_config.updated',
          'app_config.settings', 'success', 'w5-forgery-authenticated', '{}')
$sql$, '42501', null, 'authenticated cannot forge the reserved action');
reset role;

set local role identity_system;
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('system', 'script:app-config:identity', 'app_config.updated',
          'app_config.settings', 'success', 'w5-forgery-identity-system', '{}')
$sql$, '42501', null, 'identity_system cannot forge the reserved action');
reset role;
set local role privacy_system;
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('system', 'script:app-config:privacy', 'app_config.updated',
          'app_config.settings', 'success', 'w5-forgery-privacy-system', '{}')
$sql$, '42501', null, 'privacy_system cannot forge the reserved action');
reset role;
set local role app_config_system;
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('system', 'script:app-config:config', 'app_config.updated',
          'app_config.settings', 'success', 'w5-forgery-config-system', '{}')
$sql$, '42501', null, 'app_config_system cannot forge the reserved action');
reset role;
set local role platform_system;
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('system', 'script:app-config:platform', 'app_config.updated',
          'app_config.settings', 'success', 'w5-forgery-platform-system', '{}')
$sql$, '42501', null, 'platform_system cannot forge the reserved action');
reset role;
set local role ops;
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('system', 'script:app-config:ops', 'app_config.updated',
          'app_config.settings', 'success', 'w5-forgery-ops', '{}')
$sql$, '42501', null, 'ops cannot forge the reserved action');
reset role;
set local role audit_writer;
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('system', 'script:app-config:writer', 'app_config.updated',
          'app_config.settings', 'success', 'w5-forgery-audit-writer', '{}')
$sql$, '42501', null, 'audit_writer cannot forge the reserved action');
reset role;
set local role audit_operator_writer;
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('operator', '11111111-1111-4111-8111-111111111111', 'app_config.updated',
          'app_config.settings', 'success', 'w5-forgery-audit-operator', '{}')
$sql$, '42501', null, 'audit_operator_writer cannot forge the reserved action');
reset role;
set local role service_role;
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('system', 'script:app-config:service-role', 'app_config.updated',
          'app_config.settings', 'success', 'w5-forgery-service-role', '{}')
$sql$, '42501', null, 'service_role has no audit table capability despite BYPASSRLS');
reset role;

select is(
  (select count(*)::integer from audit.events
   where action = 'app_config.updated'
     and correlation_id like 'w5-forgery-%'),
  0,
  'rejected generic audit writes cannot inflate the configuration change quota'
);

select * from finish();
rollback;
