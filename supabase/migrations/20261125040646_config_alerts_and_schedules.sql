-- Supabase-supported extensions needed by the maintenance baseline. Do not pin
-- versions here; Supabase deprecated extension version clauses in August 2026.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault;

-- Restrict extension internals to the maintenance definer. In particular,
-- authenticated can be SET by api_runtime, so PUBLIC access to pg_net queues
-- or Vault decrypted secrets would cross the runtime boundary.
revoke all on schema net, vault, cron from public, anon, authenticated, api_runtime;
revoke all on all tables in schema net, vault, cron
  from public, anon, authenticated, api_runtime;
revoke all on all sequences in schema net, vault, cron
  from public, anon, authenticated, api_runtime;
-- Vault's private encryption functions are owned by supabase_admin and already
-- restricted. Do not attempt to rewrite their managed ACLs as postgres.
revoke all on all functions in schema net, cron
  from public, anon, authenticated, api_runtime;

grant usage on schema net, vault, cron to ops;
grant select (name, decrypted_secret) on vault.decrypted_secrets to ops;
grant execute on function vault._crypto_aead_det_decrypt(bytea, bytea, bigint, bytea, bytea)
  to ops;
grant select (status, start_time) on cron.job_run_details to ops;
grant execute on function net.http_post(text, jsonb, jsonb, jsonb, integer) to ops;
grant select (id) on net.http_request_queue to ops;
grant select (id, status_code, timed_out, created) on net._http_response to ops;

create table ops.alerts (
  code           text primary key check (code in (
    'cron_failures_24h',
    'purge_expired_missing',
    'audit_operator_volume',
    'audit_system_volume',
    'audit_webhook_volume',
    'operator_config_unlisted'
  )),
  value          numeric not null check (value >= 0),
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  last_sent_at   timestamptz,
  request_id     bigint,
  request_queued_at timestamptz
);
alter table ops.alerts enable row level security;
alter table ops.alerts force row level security;
revoke all on ops.alerts from public, anon, authenticated, api_runtime;
grant select, insert, update on ops.alerts to ops;
create policy alerts_ops_all on ops.alerts for all to ops
  using (true) with check (true);

create function ops.check_signals() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_signal record;
  v_last_sent_at timestamptz;
  v_alert_api_key text;
  v_alert_to text;
  v_alert_from text;
  v_request_id bigint;
  v_existing_request_id bigint;
  v_request_queued_at timestamptz;
  v_response_status integer;
  v_response_timed_out boolean;
  v_response_created timestamptz;
  v_request_still_queued boolean;
  v_now timestamptz := clock_timestamp();
begin
  for v_signal in
    select 'cron_failures_24h'::text as code, count(*)::numeric as value
    from cron.job_run_details d
    where d.status = 'failed' and d.start_time >= v_now - interval '24 hours'
    having count(*) > 0

    union all
    select 'purge_expired_missing', 1::numeric
    where not exists (
      select 1 from audit.events e
      where e.action = 'ops.purge_expired'
        and e.occurred_at >= v_now - interval '36 hours'
    )

    union all
    select 'audit_operator_volume', count(*)::numeric
    from audit.events e
    where e.actor_type = 'operator' and e.occurred_at >= v_now - interval '1 hour'
    having count(*) > 50

    union all
    select 'audit_system_volume', count(*)::numeric
    from audit.events e
    where e.actor_type = 'system' and e.occurred_at >= v_now - interval '1 hour'
    having count(*) > 1000

    union all
    select 'audit_webhook_volume', count(*)::numeric
    from audit.events e
    where e.actor_type = 'webhook' and e.occurred_at >= v_now - interval '1 hour'
    having count(*) > 2000

    union all
    select 'operator_config_unlisted', count(*)::numeric
    from audit.events e
    where e.actor_type = 'operator'
      and e.action = 'app_config.updated'
      and e.occurred_at >= v_now - interval '15 minutes'
      and not exists (
        select 1 from app_config.operator_alert_exempt_keys k
        where k.key = e.resource_ref
      )
    having count(*) > 0
  loop
    insert into ops.alerts (code, value, first_seen_at, last_seen_at)
    values (v_signal.code, v_signal.value, v_now, v_now)
    on conflict (code) do update
      set value = excluded.value, last_seen_at = excluded.last_seen_at;

    select a.last_sent_at, a.request_id, a.request_queued_at
      into v_last_sent_at, v_existing_request_id, v_request_queued_at
    from ops.alerts a where a.code = v_signal.code;

    if v_last_sent_at is not null and v_last_sent_at > v_now - interval '6 hours' then
      continue;
    end if;

    if v_existing_request_id is not null then
      select r.status_code, r.timed_out, r.created
        into v_response_status, v_response_timed_out, v_response_created
      from net._http_response r where r.id = v_existing_request_id;
      if found then
        if v_response_status between 200 and 299 and not coalesce(v_response_timed_out, false) then
          update ops.alerts
          set last_sent_at = v_response_created
          where code = v_signal.code;
          continue;
        end if;
        update ops.alerts
        set request_id = null, request_queued_at = null
        where code = v_signal.code;
      else
        select exists (
          select 1 from net.http_request_queue q where q.id = v_existing_request_id
        ) into v_request_still_queued;
        if v_request_still_queued
           or v_request_queued_at > v_now - interval '15 minutes' then
          continue;
        end if;
        update ops.alerts
        set request_id = null, request_queued_at = null
        where code = v_signal.code;
      end if;
    end if;

    -- Vault credentials are operator-managed and never have repository
    -- defaults. Missing any value persists the alert without marking it sent.
    select
      max(s.decrypted_secret) filter (where s.name = 'ALERT_RESEND_API_KEY'),
      max(s.decrypted_secret) filter (where s.name = 'ALERT_TO'),
      max(s.decrypted_secret) filter (where s.name = 'ALERT_FROM')
    into v_alert_api_key, v_alert_to, v_alert_from
    from vault.decrypted_secrets s
    where s.name in ('ALERT_RESEND_API_KEY', 'ALERT_TO', 'ALERT_FROM');

    if v_alert_api_key is null or v_alert_to is null or v_alert_from is null then
      continue;
    end if;

    begin
      v_request_id := net.http_post(
        url := 'https://api.resend.com/emails',
        body := jsonb_build_object(
          'from', v_alert_from,
          'to', v_alert_to,
          'subject', 'Base app database alert: ' || v_signal.code,
          'text', 'A database health signal crossed its configured threshold. Code: '
            || v_signal.code || '; value: ' || v_signal.value::text || '.'
        ),
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || v_alert_api_key,
          'Content-Type', 'application/json'
        ),
        timeout_milliseconds := 5000
      );
      if v_request_id is not null then
        update ops.alerts
        set request_id = v_request_id, request_queued_at = v_now
        where code = v_signal.code;
      end if;
    exception when others then
      -- Keep the alert state and retry later. Never persist provider responses
      -- or exception text: they can contain request details or credentials.
      null;
    end;
  end loop;
end;
$$;
revoke all on function ops.check_signals() from public, anon, authenticated, api_runtime,
  identity_system, privacy_system, app_config_system, platform_system;
grant execute on function ops.check_signals() to postgres;

-- PostgreSQL 17 requires temporary ownership-transfer capabilities. Object
-- grants are configured first; the migration removes its own membership again.
grant create on schema ops to ops;
grant ops to postgres with set true, inherit false;
alter function ops.check_signals() owner to ops;
revoke ops from postgres;
revoke create on schema ops from ops;

-- Named jobs are created through pg_cron functions (never direct writes to
-- cron.job, which Supabase no longer permits).
select cron.schedule('ops-purge-expired', '17 3 * * *', 'select ops.purge_expired()');
select cron.schedule('ops-check-signals', '*/15 * * * *', 'select ops.check_signals()');
