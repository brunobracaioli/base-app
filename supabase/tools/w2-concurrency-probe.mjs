import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { statSync } from 'node:fs';

const requiredEnvironment = [
  'W2_PROBE_DISPOSABLE_DATABASE',
  'W2_PROBE_DB_HOST',
  'W2_PROBE_DB_PORT',
  'W2_PROBE_DB_NAME',
  'W2_PROBE_DB_USER',
  'W2_PROBE_PGPASSFILE',
  'W2_PROBE_SSLMODE',
];

function fail(code) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`);
  process.exit(1);
}

function required(name) {
  const value = process.env[name];
  if (!value) fail(`missing_${name.toLowerCase()}`);
  return value;
}

for (const name of requiredEnvironment) required(name);

if (process.env.W2_PROBE_DISPOSABLE_DATABASE !== '1')
  fail('set_w2_probe_disposable_database_to_1_only_for_manager_owned_scratch_db');

const host = required('W2_PROBE_DB_HOST');
const port = Number(required('W2_PROBE_DB_PORT'));
const database = required('W2_PROBE_DB_NAME');
const user = required('W2_PROBE_DB_USER');
const passfile = required('W2_PROBE_PGPASSFILE');
const sslmode = required('W2_PROBE_SSLMODE');
const psql = process.env.W2_PROBE_PSQL_BIN || 'psql';

if (!Number.isInteger(port) || port < 1 || port > 65535) fail('invalid_db_port');
if (user !== 'postgres') fail('db_user_must_be_postgres_for_scratch_probe');
if (!isAbsolute(passfile)) fail('pgpassfile_must_be_absolute');
if (!['disable', 'require', 'verify-ca', 'verify-full'].includes(sslmode))
  fail('invalid_sslmode');

try {
  if ((statSync(passfile).mode & 0o077) !== 0) fail('pgpassfile_permissions_must_be_0600');
} catch {
  fail('pgpassfile_unreadable');
}

const psqlEnvironment = {
  PATH: process.env.PATH,
  PGHOST: host,
  PGPORT: String(port),
  PGDATABASE: database,
  PGUSER: user,
  PGPASSFILE: passfile,
  PGSSLMODE: sslmode,
};
if (process.env.W2_PROBE_SSLROOTCERT)
  psqlEnvironment.PGSSLROOTCERT = resolve(process.env.W2_PROBE_SSLROOTCERT);

function runPsql(sql) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      psql,
      ['--no-psqlrc', '--quiet', '--no-align', '--tuples-only', '--set=ON_ERROR_STOP=1'],
      { env: psqlEnvironment, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', () => resolvePromise({ exitCode: 127, stdout, stderr }));
    child.once('close', (exitCode) => resolvePromise({ exitCode: exitCode ?? 1, stdout, stderr }));
    child.stdin.end(sql);
  });
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseRows(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseJsonRows(stdout, expectedCount, stage) {
  const rows = parseRows(stdout);
  if (rows.length !== expectedCount) fail(`${stage}_unexpected_row_count`);
  try {
    return rows.map((row) => JSON.parse(row));
  } catch {
    fail(`${stage}_invalid_json_result`);
  }
}

const preflight = await runPsql(`
select current_user || '|' ||
       (select count(*) from identity.signup_reservations)::text || '|' ||
       (select count(*) from audit.events
        where action = 'app_config.updated'
          and occurred_at > clock_timestamp() - interval '1 hour')::text;
`);
if (preflight.exitCode !== 0) fail('preflight_query_failed');
const [preflightUser, reservationCountText, appConfigEventCountText] =
  parseRows(preflight.stdout)[0]?.split('|') || [];
if (preflightUser !== 'postgres') fail('preflight_unexpected_database_role');
if (reservationCountText !== '0' || appConfigEventCountText !== '0')
  fail('preflight_requires_fresh_signup_quota_and_app_config_quota');

const signupAttempts = 301;
const signupConnections = 16;
const signupBatches = Array.from({ length: signupConnections }, () => []);
for (let attempt = 0; attempt < signupAttempts; attempt += 1)
  signupBatches[attempt % signupConnections].push(attempt);

const anonymousEvent = "'{\"user\":{\"is_anonymous\":true}}'::jsonb";
const signupResults = await Promise.all(
  signupBatches
    .filter((batch) => batch.length > 0)
    .map(async (batch) => ({
      batch,
      result: await runPsql(
        `${batch
          .map(() => `select identity.before_user_created(${anonymousEvent});`)
          .join('\n')}\n`,
      ),
    })),
);
if (signupResults.some(({ result }) => result.exitCode !== 0))
  fail('signup_concurrency_sql_failed');

const signupRows = signupResults.flatMap(({ batch, result }) =>
  parseJsonRows(result.stdout, batch.length, 'signup'),
);
const acceptedSignups = signupRows.filter(
  (value) => value && typeof value === 'object' && Object.keys(value).length === 0,
).length;
const rejectedSignups = signupRows.filter((value) => value?.error?.http_code === 429).length;
if (signupRows.length !== signupAttempts || acceptedSignups !== 300 || rejectedSignups !== 1)
  fail('signup_quota_not_exactly_300_of_301');

const signupReadback = await runPsql('select count(*)::text from identity.signup_reservations;\n');
if (signupReadback.exitCode !== 0 || parseRows(signupReadback.stdout)[0] !== '300')
  fail('signup_reservation_readback_mismatch');

const runId = randomBytes(6).toString('hex');
const seed = await runPsql(`
insert into audit.events (actor_type, actor_ref, action, resource_type, resource_ref,
                          outcome, correlation_id, metadata)
select 'system', ${sqlLiteral(`script:pgtap:w2-probe-${runId}`)},
       'app_config.updated', 'app_config.settings', 'maintenance', 'success',
       ${sqlLiteral(`w2-probe-${runId}-seed-`)} || generated.n::text, '{}'::jsonb
from generate_series(1, 19) as generated(n);
`);
if (seed.exitCode !== 0) fail('app_config_quota_seed_failed');

const settingsReadback = await runPsql(
  "select key || '|' || updated_at::text from app_config.settings where key in ('maintenance', 'legal') order by key;\n",
);
if (settingsReadback.exitCode !== 0) fail('app_config_settings_readback_failed');
const settingTimestamps = new Map(
  parseRows(settingsReadback.stdout).map((line) => {
    const separator = line.indexOf('|');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }),
);
const maintenanceTimestamp = settingTimestamps.get('maintenance');
const legalTimestamp = settingTimestamps.get('legal');
if (!maintenanceTimestamp || !legalTimestamp) fail('app_config_settings_missing');

const actorRef = `script:app-config:${runId}`;
const updates = [
  {
    key: 'maintenance',
    value: '{"active":false}',
    timestamp: maintenanceTimestamp,
  },
  {
    key: 'legal',
    value: '{"termsVersion":"2026-01-01","privacyVersion":"2026-01-01"}',
    timestamp: legalTimestamp,
  },
];
const updateResults = await Promise.all(
  updates.map(({ key, value, timestamp }) =>
    runPsql(`\\set VERBOSITY verbose\nSET ROLE app_config_admin;\nSELECT app_config.set_setting(
  ${sqlLiteral(key)}, ${sqlLiteral(value)}::jsonb, 'system', ${sqlLiteral(actorRef)},
  ${sqlLiteral(`w2-probe-${runId}-${key}`)}, ${sqlLiteral(timestamp)}::timestamptz
);\n`),
  ),
);
const successfulUpdates = updateResults.filter((result) => result.exitCode === 0).length;
const quotaRejections = updateResults.filter(
  (result) => result.exitCode !== 0 && /\b54000\b|too many app_config changes/.test(result.stderr),
).length;
if (successfulUpdates !== 1 || quotaRejections !== 1)
  fail('app_config_concurrency_did_not_serialize_20th_and_21st');

const appConfigReadback = await runPsql(`
select count(*)::text
from audit.events
where action = 'app_config.updated'
  and correlation_id like ${sqlLiteral(`w2-probe-${runId}-%`)};
`);
if (appConfigReadback.exitCode !== 0 || parseRows(appConfigReadback.stdout)[0] !== '20')
  fail('app_config_quota_audit_readback_mismatch');

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    scratchDatabase: true,
    signup: { attempts: signupAttempts, accepted: acceptedSignups, rejected429: rejectedSignups },
    appConfig: { initialChanges: 19, concurrentChanges: 2, accepted: successfulUpdates, rejected54000: quotaRejections },
    cleanup: 'manager must reset the disposable database; no existing database was modified',
  })}\n`,
);
