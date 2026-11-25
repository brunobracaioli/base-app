-- Base application roles. The runtime login deliberately has no table grants;
-- it may only SET LOCAL one explicitly granted execution role inside a
-- transaction. Provision its password out of band after applying migrations.
create role api_runtime login noinherit;
create role migrator nologin;
create role identity_system nologin;
create role privacy_system nologin;
create role app_config_system nologin;
create role platform_system nologin;
create role ops nologin;
create role auth_fn_owner nologin;
create role app_config_admin nologin;
create role audit_writer nologin;
create role audit_operator_writer nologin;
create role audit_reader nologin;
create role app_config_writer nologin;

grant authenticated, identity_system, privacy_system, app_config_system, platform_system
  to api_runtime with set true, inherit false;

-- The detailed privacy spec explicitly authorizes these core roles to insert
-- events. These are direct role grants, not membership in audit_writer.
grant audit_writer, audit_operator_writer to app_config_admin;

create schema identity;
create schema privacy;
create schema app_config;
create schema platform;
create schema audit;
create schema ops;
create schema if not exists extensions;

revoke all on schema public from public, anon, authenticated, api_runtime;
revoke create on schema public from public, anon, authenticated;
revoke all on schema identity, privacy, app_config, platform, audit, ops
  from public, anon, authenticated, api_runtime;

grant usage on schema identity to authenticated, identity_system;
grant usage on schema privacy to authenticated, privacy_system;
grant usage on schema app_config to app_config_system, app_config_admin, app_config_writer;
grant usage on schema platform to platform_system;
grant usage on schema audit to authenticated, identity_system, privacy_system,
  app_config_system, platform_system, audit_writer, audit_operator_writer,
  audit_reader, ops;
grant usage on schema ops to ops;
grant usage, create on schema identity, privacy, app_config, platform, audit, ops
  to migrator;
grant usage on schema auth to auth_fn_owner;

-- Fixed minimum privileges for auth_fn_owner; catalog pgTAP checks compare
-- these grants and function ownership exactly.
grant select, delete on auth.users to auth_fn_owner;
grant update (banned_until, encrypted_password, raw_app_meta_data)
  on auth.users to auth_fn_owner;
grant select, delete on auth.sessions, auth.refresh_tokens, auth.identities
  to auth_fn_owner;
grant delete on auth.audit_log_entries, auth.flow_state to auth_fn_owner;

-- The application never reaches Supabase-managed Storage or Realtime objects.
revoke all on schema storage, realtime from public, anon, authenticated, api_runtime;
revoke all on all tables in schema storage, realtime
  from public, anon, authenticated, api_runtime;
revoke all on all sequences in schema storage, realtime
  from public, anon, authenticated, api_runtime;

-- api_runtime can activate a role but does not inherit its table privileges.
-- Extension migrations must use the same SET-only membership contract for
-- each boot-validated extension system role.
