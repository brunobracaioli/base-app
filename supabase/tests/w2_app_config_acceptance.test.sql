begin;
set local search_path = test_support, extensions, public;
select no_plan();

select ok(
  exists (
    select 1 from pg_catalog.pg_proc procedure
    where procedure.oid = pg_catalog.to_regprocedure(
      'app_config.set_setting(text,jsonb,text,text,text,timestamptz)'
    )
      and procedure.proowner = 'app_config_admin'::regrole
      and procedure.prosecdef
      and 'search_path=""' = any(procedure.proconfig)
  ),
  'set_setting is owned by app_config_admin and has an empty search_path'
);
select ok(
  has_function_privilege('app_config_writer',
    'app_config.set_setting(text,jsonb,text,text,text,timestamptz)', 'EXECUTE')
  and has_function_privilege('app_config_admin',
    'app_config.set_setting(text,jsonb,text,text,text,timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'app_config.set_setting(text,jsonb,text,text,text,timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon',
    'app_config.set_setting(text,jsonb,text,text,text,timestamptz)', 'EXECUTE')
  and not has_function_privilege('app_config_system',
    'app_config.set_setting(text,jsonb,text,text,text,timestamptz)', 'EXECUTE'),
  'only app_config_writer and the function owner can execute set_setting'
);
select set_eq(
  $$
    select procedure.oid::regprocedure::text
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'app_config'
      and has_function_privilege('app_config_writer', procedure.oid, 'EXECUTE')
  $$,
  $$
    values (pg_catalog.to_regprocedure(
      'app_config.set_setting(text,jsonb,text,text,text,timestamptz)'
    )::regprocedure::text)
  $$,
  'app_config_writer can execute only set_setting'
);
select ok(
  not has_table_privilege('app_config_admin', 'audit.events', 'SELECT'),
  'app_config_admin has no audit read grant under the current held decision'
);
select ok(
  has_table_privilege('app_config_system', 'app_config.settings', 'SELECT')
  and not has_table_privilege('app_config_system', 'app_config.settings', 'INSERT')
  and not has_table_privilege('app_config_system', 'app_config.settings', 'UPDATE')
  and not has_table_privilege('app_config_system', 'app_config.settings', 'DELETE'),
  'app_config_system can only read settings'
);
select ok(
  has_table_privilege('app_config_admin', 'app_config.settings', 'SELECT')
  and has_table_privilege('app_config_admin', 'app_config.settings', 'INSERT')
  and has_table_privilege('app_config_admin', 'app_config.settings', 'UPDATE')
  and not has_table_privilege('app_config_admin', 'app_config.settings', 'DELETE'),
  'app_config_admin can select, insert, and update settings without delete'
);
select ok(
  not has_table_privilege('app_config_writer', 'app_config.settings', 'SELECT')
  and not has_table_privilege('app_config_writer', 'app_config.settings', 'INSERT')
  and not has_table_privilege('app_config_writer', 'app_config.settings', 'UPDATE')
  and not has_table_privilege('app_config_writer', 'audit.events', 'SELECT')
  and not has_table_privilege('app_config_writer', 'audit.events', 'INSERT'),
  'app_config_writer can use the function but has no table grants'
);

select throws_ok($sql$
  select app_config.set_setting(
    'unknown', '{}'::jsonb, 'system', 'script:app-config:test',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null
  )
$sql$, '22023', null, 'set_setting rejects an unknown key');
select throws_ok($sql$
  select app_config.set_setting(
    null, '{}'::jsonb, 'system', 'script:app-config:test',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null
  )
$sql$, '22023', null, 'set_setting rejects a null key');
select throws_ok($sql$
  select app_config.set_setting(
    'maintenance', '{}'::jsonb, 'root', 'script:app-config:test',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null
  )
$sql$, '22023', null, 'set_setting rejects an unsupported actor type');
select throws_ok($sql$
  select app_config.set_setting(
    'maintenance', '{}'::jsonb, 'system', 'free-form',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null
  )
$sql$, '22023', null, 'system actors must use the script reference format');
select throws_ok($sql$
  select app_config.set_setting(
    'maintenance', '{}'::jsonb, null, '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null
  )
$sql$, '22023', null, 'set_setting rejects a null actor type');

select set_config('app.operator_id', '22222222-2222-4222-8222-222222222222', true);
set local role app_config_writer;
select throws_ok($sql$
  select app_config.set_setting(
    'maintenance', '{"active":true}'::jsonb, 'operator',
    '11111111-1111-4111-8111-111111111111',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    current_setting('test.maintenance_updated_at', true)::timestamptz
  )
$sql$, '42501', null, 'operator identity must match the transaction GUC');
reset role;
select is(
  (select value from app_config.settings where key = 'maintenance'),
  '{"active":false}'::jsonb,
  'an operator GUC mismatch leaves the setting unchanged'
);
select is(
  (select count(*)::integer from audit.events
   where correlation_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  0,
  'an operator GUC mismatch does not create an audit event'
);

select set_config('test.maintenance_updated_at',
  (select updated_at::text from app_config.settings where key = 'maintenance'), true);
select set_config('app.operator_id', '11111111-1111-4111-8111-111111111111', true);
set local role app_config_writer;
select lives_ok($sql$
  select app_config.set_setting(
    'maintenance', '{"active":true}'::jsonb, 'operator',
    '11111111-1111-4111-8111-111111111111',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    current_setting('test.maintenance_updated_at', true)::timestamptz
  )
$sql$, 'app_config_writer changes a setting through the audited function');
reset role;
select is(
  (select value from app_config.settings where key = 'maintenance'),
  '{"active":true}'::jsonb,
  'the successful setting update is visible'
);
select is(
  (select count(*)::integer from audit.events
   where action = 'app_config.updated'
     and correlation_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  1,
  'the setting write records one audit event in the same transaction'
);
select ok(
  (select metadata -> 'before' = '{"active":false}'::jsonb
          and metadata -> 'after' = '{"active":true}'::jsonb
   from audit.events where correlation_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  'the audit event records the before and after values'
);

set local role app_config_writer;
select throws_ok($sql$
  select app_config.set_setting(
    'maintenance', '{"active":false}'::jsonb, 'operator',
    '11111111-1111-4111-8111-111111111111',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    current_setting('test.maintenance_updated_at', true)::timestamptz
  )
$sql$, 'AC409', null, 'a stale expected timestamp returns the CAS conflict');
select throws_ok($sql$
  select app_config.set_setting(
    'maintenance', '{"active":false}'::jsonb, 'operator',
    '11111111-1111-4111-8111-111111111111',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', null
  )
$sql$, 'AC409', null, 'null expected timestamp conflicts with an existing key');
reset role;
select is(
  (select count(*)::integer from audit.events
   where action = 'app_config.updated'
     and correlation_id in (
       'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
       'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
     )),
  0,
  'CAS conflicts do not write audit events'
);

delete from app_config.settings where key = 'legal';
set local role app_config_writer;
select lives_ok($sql$
  select app_config.set_setting(
    'legal', '{"termsVersion":"2026-01-01","privacyVersion":"2026-01-01"}'::jsonb,
    'system', 'script:app-config:pgtap',
    'ffffffff-ffff-4fff-8fff-ffffffffffff', null
  )
$sql$, 'null expected timestamp creates a previously missing key');
reset role;

select * from finish();
rollback;
