import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const requiredEnvironment = [
  'W2_PROBE_DISPOSABLE_DATABASE',
  'W2_PROBE_DB_HOST',
  'W2_PROBE_DB_PORT',
  'W2_PROBE_DB_NAME',
  'W2_PROBE_DB_USER',
  'W2_PROBE_SSLMODE',
  'PGPASSWORD',
];

function fail(code, details = {}) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: code, ...details })}\n`);
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
const sslmode = required('W2_PROBE_SSLMODE');
const psql = process.env.W2_PROBE_PSQL_BIN || 'psql';

if (!Number.isInteger(port) || port < 1 || port > 65535) fail('invalid_db_port');
if (user !== 'supabase_admin') fail('db_user_must_be_supabase_admin_for_scratch_probe');
if (!['disable', 'require', 'verify-ca', 'verify-full'].includes(sslmode)) fail('invalid_sslmode');

const psqlEnvironment = {
  PATH: process.env.PATH,
  PGHOST: host,
  PGPORT: String(port),
  PGCONNECT_TIMEOUT: '10',
  PGDATABASE: database,
  PGUSER: user,
  PGPASSWORD: required('PGPASSWORD'),
  PGSSLMODE: sslmode,
};
if (process.env.W2_PROBE_SSLROOTCERT)
  psqlEnvironment.PGSSLROOTCERT = resolve(process.env.W2_PROBE_SSLROOTCERT);

function extractSqlStates(stderr) {
  return [
    ...new Set(
      [...stderr.matchAll(/(?:SQLSTATE\s+|ERROR:\s+)([0-9A-Z]{5})/gi)].map((match) => match[1]),
    ),
  ];
}

function runPsql(sql) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      psql,
      [
        '--no-psqlrc',
        '--quiet',
        '--no-align',
        '--tuples-only',
        '--set=ON_ERROR_STOP=1',
        '--set=VERBOSITY=verbose',
        '--command',
        sql,
      ],
      { env: psqlEnvironment, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 1000);
      forceKill.unref();
    }, 30_000);
    timeout.unref();
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise({
        exitCode,
        stdout,
        sqlStates: extractSqlStates(stderr),
        quotaMessage: /too many app_config changes/.test(stderr),
        timedOut,
      });
    };
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', () => finish(127));
    child.once('close', (exitCode) => finish(exitCode ?? 1));
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
  if (rows.length !== expectedCount)
    fail(`${stage}_unexpected_row_count`, { expectedCount, observedCount: rows.length });
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
if (preflight.exitCode !== 0)
  fail('preflight_query_failed', { exitCode: preflight.exitCode, sqlStates: preflight.sqlStates });
const [preflightUser, reservationCountText, appConfigEventCountText] =
  parseRows(preflight.stdout)[0]?.split('|') || [];
if (preflightUser !== 'supabase_admin') fail('preflight_unexpected_database_role');
if (reservationCountText !== '0' || appConfigEventCountText !== '0')
  fail('preflight_requires_fresh_signup_quota_and_app_config_quota');

const signupAttempts = 301;
const signupConnections = 16;
const signupBatches = Array.from({ length: signupConnections }, () => []);
for (let attempt = 0; attempt < signupAttempts; attempt += 1)
  signupBatches[attempt % signupConnections].push(attempt);

const anonymousEvent = '\'{"user":{"is_anonymous":true}}\'::jsonb';
const signupResults = await Promise.all(
  signupBatches
    .filter((batch) => batch.length > 0)
    .map(async (batch) => ({
      batch,
      result: await runPsql(
        `${batch
          .map(
            () =>
              `BEGIN;\nSET LOCAL ROLE supabase_auth_admin;\nSELECT identity.before_user_created(${anonymousEvent});\nCOMMIT;`,
          )
          .join('\n')}\n`,
      ),
    })),
);
if (signupResults.some(({ result }) => result.exitCode !== 0))
  fail('signup_concurrency_sql_failed', {
    failures: signupResults
      .filter(({ result }) => result.exitCode !== 0)
      .map(({ result }) => ({
        exitCode: result.exitCode,
        sqlStates: result.sqlStates,
        timedOut: result.timedOut,
      })),
  });

const signupRows = signupResults.flatMap(({ batch, result }) =>
  parseJsonRows(result.stdout, batch.length, 'signup'),
);
const acceptedSignups = signupRows.filter(
  (value) => value && typeof value === 'object' && Object.keys(value).length === 0,
).length;
const rejectedSignups = signupRows.filter((value) => value?.error?.http_code === 429).length;
if (signupRows.length !== signupAttempts || acceptedSignups !== 300 || rejectedSignups !== 1)
  fail('signup_quota_not_exactly_300_of_301', {
    attempts: signupAttempts,
    accepted: acceptedSignups,
    rejected429: rejectedSignups,
  });

const signupReadback = await runPsql('select count(*)::text from identity.signup_reservations;\n');
if (signupReadback.exitCode !== 0 || parseRows(signupReadback.stdout)[0] !== '300')
  fail('signup_reservation_readback_mismatch', {
    exitCode: signupReadback.exitCode,
    observedCount: parseRows(signupReadback.stdout)[0] ?? null,
    sqlStates: signupReadback.sqlStates,
  });

const runId = randomBytes(6).toString('hex');
const seed = await runPsql(`
DO $probe$
DECLARE
  v_expected_updated_at timestamptz;
  v_change integer;
BEGIN
  FOR v_change IN 1..19 LOOP
    SELECT settings.updated_at
      INTO v_expected_updated_at
    FROM app_config.settings settings
    WHERE settings.key = 'maintenance';

    PERFORM app_config.set_setting(
      'maintenance', '{"active":false}'::jsonb, 'system',
      ${sqlLiteral(`script:app-config:w2-probe-${runId}`)},
      ${sqlLiteral(`w2-probe-${runId}-seed-`)} || v_change::text,
      v_expected_updated_at
    );
  END LOOP;
END
$probe$;
`);
if (seed.exitCode !== 0)
  fail('app_config_quota_seed_failed', { exitCode: seed.exitCode, sqlStates: seed.sqlStates });

const settingsReadback = await runPsql(
  "select key || '|' || updated_at::text from app_config.settings where key in ('maintenance', 'legal') order by key;\n",
);
if (settingsReadback.exitCode !== 0)
  fail('app_config_settings_readback_failed', {
    exitCode: settingsReadback.exitCode,
    sqlStates: settingsReadback.sqlStates,
  });
const settingTimestamps = new Map(
  parseRows(settingsReadback.stdout).map((line) => {
    const separator = line.indexOf('|');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }),
);
const maintenanceTimestamp = settingTimestamps.get('maintenance');
const legalTimestamp = settingTimestamps.get('legal');
if (!maintenanceTimestamp || !legalTimestamp)
  fail('app_config_settings_missing', {
    maintenancePresent: Boolean(maintenanceTimestamp),
    legalPresent: Boolean(legalTimestamp),
  });

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
    runPsql(`BEGIN;\nSET LOCAL ROLE app_config_writer;\nSELECT app_config.set_setting(
  ${sqlLiteral(key)}, ${sqlLiteral(value)}::jsonb, 'system', ${sqlLiteral(actorRef)},
  ${sqlLiteral(`w2-probe-${runId}-${key}`)}, ${sqlLiteral(timestamp)}::timestamptz
);\nCOMMIT;\n`),
  ),
);
const successfulUpdates = updateResults.filter((result) => result.exitCode === 0).length;
const quotaRejections = updateResults.filter(
  (result) => result.exitCode !== 0 && (result.sqlStates.includes('54000') || result.quotaMessage),
).length;
if (successfulUpdates !== 1 || quotaRejections !== 1)
  fail('app_config_concurrency_did_not_serialize_20th_and_21st', {
    accepted: successfulUpdates,
    rejected54000: quotaRejections,
    failures: updateResults
      .filter((result) => result.exitCode !== 0)
      .map((result) => ({
        exitCode: result.exitCode,
        sqlStates: result.sqlStates,
        timedOut: result.timedOut,
      })),
  });

const appConfigReadback = await runPsql(`
select count(*)::text
from audit.events
where action = 'app_config.updated'
  and correlation_id like ${sqlLiteral(`w2-probe-${runId}-%`)};
`);
if (appConfigReadback.exitCode !== 0 || parseRows(appConfigReadback.stdout)[0] !== '20')
  fail('app_config_quota_audit_readback_mismatch', {
    exitCode: appConfigReadback.exitCode,
    observedCount: parseRows(appConfigReadback.stdout)[0] ?? null,
    sqlStates: appConfigReadback.sqlStates,
  });

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    scratchDatabase: true,
    signup: { attempts: signupAttempts, accepted: acceptedSignups, rejected429: rejectedSignups },
    appConfig: {
      initialChanges: 19,
      concurrentChanges: 2,
      accepted: successfulUpdates,
      rejected54000: quotaRejections,
    },
    cleanup: 'manager must reset the disposable database; no existing database was modified',
  })}\n`,
);
