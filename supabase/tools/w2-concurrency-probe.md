# W2 concurrency probe

Run `w2-concurrency-probe.mjs` only against the manager-owned disposable W2 database after a
fresh reset. The script refuses to run unless `W2_PROBE_DISPOSABLE_DATABASE=1`, the connection
role is `postgres`, the signup reservation table is empty, and no `app_config.updated` event
exists in the last hour.

Supply connection values through the environment; the repository contains no credentials.
`W2_PROBE_PGPASSFILE` must point to a private file with mode `0600`. Set the SSL mode appropriate
for the manager's local connection. For example, the shell environment must provide:

```text
W2_PROBE_DISPOSABLE_DATABASE=1
W2_PROBE_DB_HOST
W2_PROBE_DB_PORT
W2_PROBE_DB_NAME
W2_PROBE_DB_USER=postgres
W2_PROBE_PGPASSFILE
W2_PROBE_SSLMODE
```

Then run:

```bash
node supabase/tools/w2-concurrency-probe.mjs
```

The probe submits 301 anonymous-hook calls through concurrent PostgreSQL sessions and expects
exactly 300 reservations plus one HTTP 429 result. It then seeds 19 count-only configuration
events and races two valid writes on different keys; exactly one write must commit as change 20,
and the other must fail with SQLSTATE `54000`. This also exercises the fresh-snapshot quota read
after the transaction advisory lock.

The probe leaves only opaque signup reservations and synthetic count-only audit rows in the
scratch database. Reset that disposable database after recording the JSON result. It does not
exercise GoTrue's actual `supabase_auth_admin` hook call; the separate real Auth/SMTP harness is
required for that proof. Never point this probe at a hosted or otherwise existing database.
