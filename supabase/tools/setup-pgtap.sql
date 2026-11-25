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
grant usage on schema test_support to anon, authenticated, api_runtime,
  identity_system, privacy_system, app_config_system, platform_system,
  audit_writer, audit_operator_writer, audit_reader, app_config_writer,
  supabase_auth_admin;
grant execute on all functions in schema test_support to anon, authenticated,
  api_runtime, identity_system, privacy_system, app_config_system, platform_system,
  audit_writer, audit_operator_writer, audit_reader, app_config_writer,
  supabase_auth_admin;
