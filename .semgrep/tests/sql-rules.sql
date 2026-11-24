// ruleid: base-app.no-session-set-in-migrations
SET SESSION ROLE app_admin;

// ruleid: base-app.no-session-set-in-migrations
SET search_path = public;

// ok: base-app.no-session-set-in-migrations
CREATE FUNCTION x.safe() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

// ok: base-app.no-session-set-in-migrations
select set_config('app.user_id', $1, true);

// ruleid: base-app.no-direct-audit-events-insert
insert into audit.events (event_id) values ('x');

// ruleid: base-app.no-direct-audit-events-insert
INSERT INTO "audit"."events" (event_id) VALUES ('x');

// ok: base-app.no-direct-audit-events-insert
INSERT INTO public.events (event_id) values ('x');

// ok: base-app.no-direct-audit-events-insert
select platform.record_audit_event($1);
