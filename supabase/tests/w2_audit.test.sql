begin;
set local search_path = test_support, extensions, public;
select no_plan();

select ok(has_table_privilege('authenticated', 'audit.events', 'INSERT'),
  'authenticated can insert its own audit event');
select ok(not has_table_privilege('authenticated', 'audit.events', 'SELECT')
          and not has_table_privilege('authenticated', 'audit.events', 'UPDATE')
          and not has_table_privilege('authenticated', 'audit.events', 'DELETE'),
  'authenticated cannot read or mutate audit events');

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($sql$
  insert into audit.events (actor_type, actor_ref, subject_ref, action, resource_type,
                            resource_ref, outcome, correlation_id, metadata)
  values ('user', '11111111-1111-4111-8111-111111111111',
          '11111111-1111-4111-8111-111111111111', 'test.user_event', 'test', 'self',
          'success', '11111111-1111-4111-8111-111111111111', '{}')
$sql$, 'a user can insert an event attributed only to the current user');
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('user', '22222222-2222-4222-8222-222222222222', 'test.user_event', 'test',
          'success', '11111111-1111-4111-8111-111111111111', '{}')
$sql$, '42501', null, 'a user cannot attribute an event to another user');
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('operator', '11111111-1111-4111-8111-111111111111', 'test.user_event', 'test',
          'success', '11111111-1111-4111-8111-111111111111', '{}')
$sql$, '42501', null, 'a user cannot forge an operator event');
reset role;

select ok(has_table_privilege('identity_system', 'audit.events', 'INSERT'),
  'identity_system receives only its documented system-event insert');
set local role identity_system;
select lives_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('system', 'script:pgtap:identity', 'test.identity_event', 'test', 'success',
          '22222222-2222-4222-8222-222222222222', '{}')
$sql$, 'a core context can write a system event');
select lives_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('webhook', null, 'test.webhook_event', 'test', 'success',
          '22222222-2222-4222-8222-222222222223', '{}')
$sql$, 'a core context can write a webhook event');
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('operator', '11111111-1111-4111-8111-111111111111', 'test.identity_event',
          'test', 'success', '22222222-2222-4222-8222-222222222224', '{}')
$sql$, '42501', null, 'a core context cannot attribute an operator event');
reset role;

select ok(has_table_privilege('audit_writer', 'audit.events', 'INSERT')
          and not has_table_privilege('audit_writer', 'audit.events', 'SELECT')
          and not has_table_privilege('audit_writer', 'audit.events', 'UPDATE')
          and not has_table_privilege('audit_writer', 'audit.events', 'DELETE'),
  'audit_writer has INSERT only');
set local role audit_writer;
select lives_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('system', 'script:pgtap:writer', 'test.writer_event', 'test', 'success',
          '33333333-3333-4333-8333-333333333331', '{}')
$sql$, 'audit_writer accepts system events');
select lives_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('webhook', null, 'test.writer_webhook', 'test', 'success',
          '33333333-3333-4333-8333-333333333332', '{}')
$sql$, 'audit_writer accepts webhook events');
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('user', '11111111-1111-4111-8111-111111111111', 'test.writer_user',
          'test', 'success', '33333333-3333-4333-8333-333333333333', '{}')
$sql$, '42501', null, 'audit_writer rejects user events');
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('operator', '11111111-1111-4111-8111-111111111111', 'test.writer_operator',
          'test', 'success', '33333333-3333-4333-8333-333333333334', '{}')
$sql$, '42501', null, 'audit_writer rejects operator events');
reset role;

select ok(has_table_privilege('audit_operator_writer', 'audit.events', 'INSERT')
          and not has_table_privilege('audit_operator_writer', 'audit.events', 'SELECT')
          and not has_table_privilege('audit_operator_writer', 'audit.events', 'UPDATE')
          and not has_table_privilege('audit_operator_writer', 'audit.events', 'DELETE'),
  'audit_operator_writer has INSERT only');
set local role audit_operator_writer;
select lives_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('operator', '11111111-1111-4111-8111-111111111111', 'test.operator_event',
          'test', 'success', '44444444-4444-4444-8444-444444444441', '{}')
$sql$, 'audit_operator_writer accepts operator events');
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('system', 'script:pgtap:operator', 'test.operator_system', 'test', 'success',
          '44444444-4444-4444-8444-444444444442', '{}')
$sql$, '42501', null, 'audit_operator_writer rejects system events');
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('webhook', null, 'test.operator_webhook', 'test', 'success',
          '44444444-4444-4444-8444-444444444443', '{}')
$sql$, '42501', null, 'audit_operator_writer rejects webhook events');
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('user', '11111111-1111-4111-8111-111111111111', 'test.operator_user',
          'test', 'success', '44444444-4444-4444-8444-444444444444', '{}')
$sql$, '42501', null, 'audit_operator_writer rejects user events');
reset role;

select ok(has_table_privilege('audit_reader', 'audit.events', 'SELECT')
          and not has_table_privilege('audit_reader', 'audit.events', 'INSERT')
          and not has_table_privilege('audit_reader', 'audit.events', 'UPDATE')
          and not has_table_privilege('audit_reader', 'audit.events', 'DELETE'),
  'audit_reader has SELECT only');
set local role audit_reader;
select ok((select count(*) > 0 from audit.events), 'audit_reader can read the audit trail');
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('system', 'script:pgtap:reader', 'test.reader_event', 'test', 'success',
          '55555555-5555-4555-8555-555555555551', '{}')
$sql$, '42501', null, 'audit_reader cannot insert');
reset role;

select ok(has_table_privilege('app_config_admin', 'audit.events', 'INSERT')
          and not has_table_privilege('app_config_admin', 'audit.events', 'SELECT')
          and not has_table_privilege('app_config_admin', 'audit.events', 'UPDATE')
          and not has_table_privilege('app_config_admin', 'audit.events', 'DELETE'),
  'app_config_admin inherits both insert-only audit roles and no read access');
set local role app_config_admin;
select lives_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('system', 'script:pgtap:config', 'test.config_system', 'test', 'success',
          '66666666-6666-4666-8666-666666666661', '{}')
$sql$, 'app_config_admin can write a system event through audit_writer');
select lives_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('operator', '11111111-1111-4111-8111-111111111111', 'test.config_operator',
          'test', 'success', '66666666-6666-4666-8666-666666666662', '{}')
$sql$, 'app_config_admin can write an operator event through audit_operator_writer');
reset role;

select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('system', 'free-form human reference', 'test.invalid_actor_ref', 'test',
          'success', '77777777-7777-4777-8777-777777777771', '{}')
$sql$, '23514', null, 'actor_ref rejects free-form identifiers');
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, subject_ref, action, resource_type,
                            outcome, correlation_id, metadata)
  values ('system', 'script:pgtap:format', 'free-form subject', 'test.invalid_subject',
          'test', 'success', '77777777-7777-4777-8777-777777777772', '{}')
$sql$, '23514', null, 'subject_ref accepts only UUIDs or HMAC references');
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, resource_ref,
                            outcome, correlation_id, metadata)
  values ('system', 'script:pgtap:format', 'test.invalid_resource', 'test',
          '11111111-1111-4111-8111-111111111111', 'success',
          '77777777-7777-4777-8777-777777777773', '{}')
$sql$, '23514', null, 'resource_ref cannot contain a user UUID');
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('system', 'script:pgtap:format', 'InvalidAction', 'test', 'success',
          '77777777-7777-4777-8777-777777777774', '{}')
$sql$, '23514', null, 'action uses the dotted lowercase event format');
select throws_ok($sql$
  insert into audit.events (actor_type, actor_ref, action, resource_type, outcome,
                            correlation_id, metadata)
  values ('system', 'script:pgtap:format', 'test.metadata_size', 'test', 'success',
          '77777777-7777-4777-8777-777777777775',
          jsonb_build_object('payload', repeat('x', 5000)))
$sql$, '23514', null, 'metadata above 4 KB is rejected');

insert into audit.events (id, actor_type, actor_ref, action, resource_type, outcome,
                          correlation_id, metadata)
values ('88888888-8888-4888-8888-888888888881', 'system', 'script:pgtap:guard',
        'test.mutation_guard', 'test', 'success',
        '88888888-8888-4888-8888-888888888882', '{}');
grant select (id, actor_ref, subject_ref), update (actor_ref, subject_ref), delete
  on audit.events to audit_writer;
create policy pgtap_guard_select on audit.events for select to audit_writer using (true);
create policy pgtap_guard_update on audit.events for update to audit_writer
  using (true) with check (true);
create policy pgtap_guard_delete on audit.events for delete to audit_writer using (true);

set local role audit_writer;
select set_config('audit.mutation', 'purge', true);
select throws_ok($sql$
  delete from audit.events where id = '88888888-8888-4888-8888-888888888881'
$sql$, '42501', 'audit.events is append-only',
  'a forged purge GUC cannot bypass the append-only trigger');
select set_config('audit.mutation', 'pseudonymize', true);
select throws_ok($sql$
  update audit.events set actor_ref = '99999999-9999-4999-8999-999999999991'
  where id = '88888888-8888-4888-8888-888888888881'
$sql$, '42501', 'audit.events is append-only',
  'a forged pseudonymize GUC cannot bypass the append-only trigger');
reset role;

select * from finish();
rollback;
