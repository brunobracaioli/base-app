create function identity.clear_unverified_password()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update auth.users
  set encrypted_password = ''
  where id = new.id
    and encrypted_password <> '';

  return null;
end;
$$;

alter function identity.clear_unverified_password() owner to postgres;
revoke all on function identity.clear_unverified_password()
  from public, anon, authenticated, service_role, api_runtime, migrator,
       identity_system, privacy_system, app_config_system, platform_system,
       ops, app_config_admin, audit_writer, audit_operator_writer, audit_reader,
       app_config_writer, app_config_history_reader;
grant execute on function identity.clear_unverified_password() to supabase_auth_admin;

create trigger clear_unverified_password_after_email_confirmation
after update of email_confirmed_at on auth.users
for each row
when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
execute function identity.clear_unverified_password();
