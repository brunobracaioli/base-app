// ruleid: base-app.no-console
console.log('private user data');

// ok: base-app.no-console
logger.info({ event: 'request.completed' }, 'Request completed');

// ruleid: base-app.no-sql-raw
sql.raw('select * from users');

// ok: base-app.no-sql-raw
sql`select * from users where id = ${userId}`;

// ruleid: base-app.no-sql-lit
sql.lit(untrustedInput);

// ok: base-app.no-sql-lit
sql`select * from users where id = ${userId}`;

// ruleid: base-app.no-session-set
sql`SET ROLE app_admin`;

// ruleid: base-app.no-session-set
sql`SET app.user_id = ${userId}`;

// ok: base-app.no-session-set
sql`select set_config('app.user_id', ${userId}, true)`;

// ok: base-app.no-session-set
// ok: base-app.no-direct-audit-events-in-query-string
sql`CREATE FUNCTION x.safe() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''`;

// ruleid: base-app.no-direct-audit-events-in-query-string
sql`insert into audit.events (event_id) values (${eventId})`;

// ruleid: base-app.no-direct-audit-events-kysely
db.insertInto('audit.events');

// ruleid: base-app.no-direct-audit-events-kysely
db.insertInto('audit.events');

// ok: base-app.no-direct-audit-events-kysely
db.insertInto('public.events');
