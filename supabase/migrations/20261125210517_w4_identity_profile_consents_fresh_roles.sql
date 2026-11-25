-- W4 adds minimal identity and consent records and exposes one narrow fresh-role
-- lookup. The W2 baseline remains immutable; this migration is safe to apply
-- after that baseline on the current template database.

create table identity.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) between 1 and 80),
  locale       text not null check (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table identity.profiles enable row level security;
alter table identity.profiles force row level security;
revoke all on identity.profiles from public, anon, authenticated, service_role,
  api_runtime, migrator, identity_system, privacy_system, app_config_system,
  platform_system, ops, app_config_admin, app_config_writer, audit_writer,
  audit_operator_writer, audit_reader;
grant select, insert on identity.profiles to authenticated;
grant update (display_name, locale, updated_at) on identity.profiles to authenticated;
grant select, delete on identity.profiles to identity_system;

create policy profiles_select_own on identity.profiles for select to authenticated
  using (user_id = (select auth.uid()));
create policy profiles_insert_own on identity.profiles for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy profiles_update_own on identity.profiles for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy profiles_system_select on identity.profiles for select to identity_system
  using (true);
create policy profiles_system_delete on identity.profiles for delete to identity_system
  using (true);

create function identity.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;
revoke all on function identity.touch_updated_at() from public, anon, authenticated,
  service_role, api_runtime, migrator, identity_system, privacy_system,
  app_config_system, platform_system, ops, app_config_admin, app_config_writer,
  audit_writer, audit_operator_writer, audit_reader;
create trigger profiles_touch before update on identity.profiles
  for each row execute function identity.touch_updated_at();

create table privacy.consents (
  user_id     uuid not null references auth.users(id) on delete cascade,
  document    text not null check (document in ('terms', 'privacy')),
  version     text not null check (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  accepted_at timestamptz not null default now(),
  primary key (user_id, document, version)
);

alter table privacy.consents enable row level security;
alter table privacy.consents force row level security;
revoke all on privacy.consents from public, anon, authenticated, service_role,
  api_runtime, migrator, identity_system, privacy_system, app_config_system,
  platform_system, ops, app_config_admin, app_config_writer, audit_writer,
  audit_operator_writer, audit_reader;
grant select, insert on privacy.consents to authenticated;
grant select, delete on privacy.consents to privacy_system;

create policy consents_select_own on privacy.consents for select to authenticated
  using (user_id = (select auth.uid()));
create policy consents_insert_own on privacy.consents for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy consents_system_select on privacy.consents for select to privacy_system
  using (true);
create policy consents_system_delete on privacy.consents for delete to privacy_system
  using (true);

create function identity.read_fresh_roles(p_user_id uuid)
returns table (roles jsonb)
language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null or p_user_id is distinct from auth.uid() then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  return query
    select auth_user.raw_app_meta_data -> 'roles'
    from auth.users as auth_user
    where auth_user.id = p_user_id;
end;
$$;
alter function identity.read_fresh_roles(uuid) owner to postgres;
revoke all on function identity.read_fresh_roles(uuid) from public, anon,
  service_role, api_runtime, migrator, identity_system, privacy_system,
  app_config_system, platform_system, ops, app_config_admin, app_config_writer,
  audit_writer, audit_operator_writer, audit_reader, supabase_auth_admin;
grant execute on function identity.read_fresh_roles(uuid) to authenticated;
