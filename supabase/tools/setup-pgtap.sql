-- Test-only helpers live outside production schemas. Run as the disposable
-- fixture administrator after loading the generated registry tables.
create extension if not exists pgtap with schema test_support;
do $$
begin
  if exists (
    select 1 from pg_extension
    where extname = 'pgtap' and extnamespace <> 'test_support'::regnamespace
  ) then
    alter extension pgtap set schema test_support;
  end if;
end;
$$;
create or replace function test_support.private_storage_fixture_count()
returns integer
language plpgsql set search_path = ''
as $$
declare
  v_count integer;
begin
  begin
    if pg_catalog.to_regclass('storage.objects') is null then
      return null;
    end if;
  exception when insufficient_privilege then
    return -1;
  end;
  begin
    execute $query$
      select count(*)::integer
      from storage.objects
      where bucket_id = 'w2-pgtap-private' and name = 'fixture.txt'
    $query$ into v_count;
    return v_count;
  exception when insufficient_privilege then
    return -1;
  end;
end;
$$;

create or replace function test_support.private_realtime_fixture_count()
returns integer
language plpgsql set search_path = ''
as $$
declare
  v_count integer;
begin
  begin
    if pg_catalog.to_regclass('realtime.messages') is null then
      return null;
    end if;
  exception when insufficient_privilege then
    return -1;
  end;
  begin
    execute $query$
      select count(*)::integer
      from realtime.messages
      where topic = 'w2-pgtap-private-topic' and private
    $query$ into v_count;
    return v_count;
  exception when insufficient_privilege then
    return -1;
  end;
end;
$$;

create or replace function test_support.private_storage_fixture_insert_denied()
returns boolean
language plpgsql set search_path = ''
as $$
begin
  begin
    if pg_catalog.to_regclass('storage.objects') is null then
      return null;
    end if;
  exception when insufficient_privilege then
    return true;
  end;
  begin
    execute $query$
      insert into storage.objects (bucket_id, name, owner_id, metadata)
      values ('w2-pgtap-private', 'unauthorized-write.txt',
              'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '{"mimetype":"text/plain"}')
    $query$;
    raise exception 'fixture write unexpectedly succeeded' using errcode = 'P0001';
  exception
    when insufficient_privilege then
      return true;
    when sqlstate 'P0001' then
      if sqlerrm = 'fixture write unexpectedly succeeded' then
        return false;
      end if;
      raise;
  end;
end;
$$;

create or replace function test_support.private_realtime_fixture_insert_denied()
returns boolean
language plpgsql set search_path = ''
as $$
begin
  begin
    if pg_catalog.to_regclass('realtime.messages') is null then
      return null;
    end if;
  exception when insufficient_privilege then
    return true;
  end;
  begin
    execute $query$
      insert into realtime.messages (topic, extension, private, event, payload)
      values ('w2-pgtap-private-topic', 'broadcast', true, 'INSERT', '{"forbidden":true}')
    $query$;
    raise exception 'fixture write unexpectedly succeeded' using errcode = 'P0001';
  exception
    when insufficient_privilege then
      return true;
    when sqlstate 'P0001' then
      if sqlerrm = 'fixture write unexpectedly succeeded' then
        return false;
      end if;
      raise;
  end;
end;
$$;

grant usage on schema test_support to anon, authenticated, api_runtime,
  identity_system, privacy_system, app_config_system, platform_system,
  ops, app_config_admin, audit_writer, audit_operator_writer, audit_reader,
  app_config_writer, supabase_auth_admin, service_role;
grant execute on all functions in schema test_support to anon, authenticated,
  api_runtime, identity_system, privacy_system, app_config_system, platform_system,
  ops, app_config_admin, audit_writer, audit_operator_writer, audit_reader,
  app_config_writer, supabase_auth_admin, service_role;
