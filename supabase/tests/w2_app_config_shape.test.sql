begin;
set local search_path = test_support, extensions, public;
select no_plan();

select ok(
  app_config.valid_versions(
    '{"ios":{"minSupported":"1.9.0","latest":"1.10.0"},"android":{"minSupported":"1.0.0","latest":"1.0.0"}}'::jsonb
  ),
  'valid version settings compare semantic version components numerically'
);
select ok(
  not app_config.valid_versions(
    '{"ios":{"minSupported":"1.10.0","latest":"1.9.0"},"android":{"minSupported":"1.0.0","latest":"1.0.0"}}'::jsonb
  ),
  'versions reject minSupported greater than latest'
);
select ok(
  app_config.valid_versions(
    '{"ios":{"minSupported":"2147483648.0.0","latest":"2147483649.0.0"},"android":{"minSupported":"1.0.0","latest":"1.0.0"}}'::jsonb
  )
  and not app_config.valid_versions(
    '{"ios":{"minSupported":"2147483649.0.0","latest":"2147483648.0.0"},"android":{"minSupported":"1.0.0","latest":"1.0.0"}}'::jsonb
  ),
  'SQL compares components beyond the signed 32-bit range without overflow'
);
select ok(
  app_config.valid_versions(
    '{"ios":{"minSupported":"9999999999999999999999999999999999999999.0.0","latest":"10000000000000000000000000000000000000000.0.0"},"android":{"minSupported":"1.0.0","latest":"1.0.0"}}'::jsonb
  ),
  'SQL compares very long decimal components without integer casts'
);
select ok(
  app_config.valid_versions(
    '{"ios":{"minSupported":"1.99.100","latest":"1.100.0"},"android":{"minSupported":"1.0.0","latest":"1.0.0"}}'::jsonb
  ),
  'SQL compares semantic versions lexicographically by numeric component'
);
select is(
  app_config.semver_key('1.2.3'),
  array[1, 2, 3],
  'the original semver_key helper remains compatible'
);

select throws_ok($sql$
  update app_config.settings
  set value = '{"ios":{"minSupported":"1.0.0","latest":"1.0.0"}}'::jsonb
  where key = 'versions'
$sql$, '23514', null, 'versions require both iOS and Android values');
select throws_ok($sql$
  update app_config.settings
  set value = '{"ios":{"minSupported":"1.0.0","latest":"1.0.0"},"android":null}'::jsonb
  where key = 'versions'
$sql$, '23514', null, 'versions reject a null platform value');
select throws_ok($sql$
  update app_config.settings
  set value = '{"ios":{"latest":"1.0.0"},"android":{"minSupported":"1.0.0","latest":"1.0.0"}}'::jsonb
  where key = 'versions'
$sql$, '23514', null, 'versions require minSupported and latest on every platform');
select throws_ok($sql$
  update app_config.settings
  set value = '{"ios":{"minSupported":"1.0.0","latest":"1.0.0"},"android":{"minSupported":"1.0.0","latest":null}}'::jsonb
  where key = 'versions'
$sql$, '23514', null, 'versions reject null semantic-version fields');

select throws_ok($sql$
  update app_config.settings set value = '{}'::jsonb where key = 'maintenance'
$sql$, '23514', null, 'maintenance requires the active field');
select throws_ok($sql$
  update app_config.settings
  set value = '{"active":null}'::jsonb
  where key = 'maintenance'
$sql$, '23514', null, 'maintenance rejects a null active flag');
select throws_ok($sql$
  update app_config.settings
  set value = '{"active":false,"messageKey":"not-a-maintenance-key"}'::jsonb
  where key = 'maintenance'
$sql$, '23514', null, 'maintenance message keys follow the fixed namespace');

select throws_ok($sql$
  update app_config.settings
  set value = '{"termsVersion":"2026-01-01"}'::jsonb
  where key = 'legal'
$sql$, '23514', null, 'legal settings require both document versions');
select throws_ok($sql$
  update app_config.settings
  set value = '{"termsVersion":"2026-01-01","privacyVersion":null}'::jsonb
  where key = 'legal'
$sql$, '23514', null, 'legal settings reject a null document version');

select throws_ok($sql$
  insert into app_config.settings (key, value)
  values ('unknown', '{"active":false}'::jsonb)
$sql$, '23514', null, 'settings reject keys outside the contract allowlist');

select * from finish();
rollback;
