begin;
set local search_path = test_support, extensions, public;
select no_plan();

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
values
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pgtap-idempotency-a@example.invalid', now(), now()),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pgtap-idempotency-b@example.invalid', now(), now());

select is(
  (select string_agg(attribute.attname, ',' order by key_column.ordinality)
   from pg_catalog.pg_constraint constraint_row
   join pg_catalog.pg_class relation on relation.oid = constraint_row.conrelid
   join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
   cross join lateral unnest(constraint_row.conkey) with ordinality as key_column(attnum, ordinality)
   join pg_catalog.pg_attribute attribute
     on attribute.attrelid = relation.oid and attribute.attnum = key_column.attnum
   where namespace.nspname = 'platform' and relation.relname = 'idempotency_keys'
     and constraint_row.contype = 'p'),
  'user_id,key',
  'the primary key scopes a key by user'
);

select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_catalog.pg_class
   where oid = 'platform.idempotency_keys'::regclass),
  'idempotency keys have forced RLS'
);
select ok(
  not has_table_privilege('authenticated', 'platform.idempotency_keys', 'SELECT')
  and not has_table_privilege('authenticated', 'platform.idempotency_keys', 'INSERT')
  and not has_table_privilege('authenticated', 'platform.idempotency_keys', 'UPDATE')
  and not has_table_privilege('authenticated', 'platform.idempotency_keys', 'DELETE'),
  'authenticated has no direct idempotency-table access'
);

set local role platform_system;
select lives_ok($sql$
  insert into platform.idempotency_keys
    (user_id, key, request_hash, state, locked_until, expires_at)
  values
    ('11111111-1111-4111-8111-111111111111',
     'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repeat('a', 64), 'in_progress',
     clock_timestamp() - interval '1 minute', clock_timestamp() + interval '24 hours'),
    ('22222222-2222-4222-8222-222222222222',
     'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repeat('b', 64), 'in_progress',
     clock_timestamp() - interval '1 minute', clock_timestamp() + interval '24 hours')
$sql$, 'the same idempotency key can coexist for two users');
select is(
  (select count(*)::integer from platform.idempotency_keys
   where key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  2,
  'the same key is stored in independent user scopes'
);
select throws_ok($sql$
  insert into platform.idempotency_keys
    (user_id, key, request_hash, state, locked_until, expires_at)
  values
    ('11111111-1111-4111-8111-111111111111',
     'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repeat('c', 64), 'in_progress',
     clock_timestamp() + interval '1 minute', clock_timestamp() + interval '24 hours')
$sql$, '23505', null, 'a user cannot create two rows for one key');
with reclaimed as (
     update platform.idempotency_keys
     set locked_until = clock_timestamp() + interval '60 seconds'
     where user_id = '11111111-1111-4111-8111-111111111111'
       and key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
       and state = 'in_progress'
       and locked_until < clock_timestamp()
     returning 1
   )
select is((select count(*)::integer from reclaimed),
  1,
  'platform_system can claim an expired in-progress lease'
);
select is(
  (select request_hash from platform.idempotency_keys
   where user_id = '22222222-2222-4222-8222-222222222222'
     and key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  repeat('b', 64),
  'reclaiming one user lease leaves the other user key untouched'
);
select throws_ok($sql$
  insert into platform.idempotency_keys
    (user_id, key, request_hash, state, locked_until, expires_at)
  values
    ('11111111-1111-4111-8111-111111111111',
     'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'not-a-sha256', 'in_progress',
     clock_timestamp() + interval '60 seconds', clock_timestamp() + interval '24 hours')
$sql$, '23514', null, 'request hashes must be lowercase SHA-256 hex');
select throws_ok($sql$
  insert into platform.idempotency_keys
    (user_id, key, request_hash, state, locked_until, response_status, response_body, expires_at)
  values
    ('11111111-1111-4111-8111-111111111111',
     'cccccccc-cccc-4ccc-8ccc-cccccccccccc', repeat('c', 64), 'completed',
     clock_timestamp() + interval '60 seconds', 500, '{}', clock_timestamp() + interval '24 hours')
$sql$, '23514', null, 'completed idempotency responses must be successful 2xx results');
reset role;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select throws_ok('select count(*) from platform.idempotency_keys', '42501', null,
  'authenticated cannot read keys, including another user key');
select throws_ok($sql$
  insert into platform.idempotency_keys
    (user_id, key, request_hash, state, locked_until, expires_at)
  values
    ('11111111-1111-4111-8111-111111111111',
     'dddddddd-dddd-4ddd-8ddd-dddddddddddd', repeat('d', 64), 'in_progress',
     clock_timestamp() + interval '60 seconds', clock_timestamp() + interval '24 hours')
$sql$, '42501', null, 'authenticated cannot insert a forged key');
reset role;

select * from finish();
rollback;
