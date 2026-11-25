import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED_API_ORIGIN = 'http://127.0.0.1:54421';
const RESULT_MARKER = 'W4_API_PROOF_RESULT=';
const BUNDLE_PATH =
  process.env.W4_API_PROOF_BUNDLE ?? path.join(os.tmpdir(), 'app-base-w4-api-proof.bundle.mjs');

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(code) {
  emit({ passed: false, checks: [], failedCheck: code });
  process.exitCode = 1;
}

async function buildBundle() {
  if (!path.isAbsolute(BUNDLE_PATH)) throw new Error('bundle_path');
  const require = createRequire(import.meta.url);
  const esbuild = require(path.join(REPOSITORY_ROOT, 'node_modules/.pnpm/node_modules/esbuild'));
  await esbuild.build({
    absWorkingDir: REPOSITORY_ROOT,
    entryPoints: ['apps/web/scripts/w4-api-proof.ts'],
    outfile: BUNDLE_PATH,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'bundle',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'silent',
    banner: {
      js: [
        'import { createRequire as __w4CreateRequire } from "node:module";',
        'import { fileURLToPath as __w4FileURLToPath } from "node:url";',
        'import { dirname as __w4Dirname } from "node:path";',
        'const require = __w4CreateRequire(import.meta.url);',
        'const __filename = __w4FileURLToPath(import.meta.url);',
        'const __dirname = __w4Dirname(__filename);',
      ].join('\n'),
    },
  });
}

function assertBuiltBundle() {
  if (!path.isAbsolute(BUNDLE_PATH)) throw new Error('bundle_path');
  const stat = lstatSync(BUNDLE_PATH);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error('bundle_missing');
  }
}

function readPrivateJsonFile(environmentName, fallbackPath) {
  const configuredPath = process.env[environmentName] ?? fallbackPath;
  if (!path.isAbsolute(configuredPath)) throw new Error('private_path');
  const resolved = path.resolve(configuredPath);
  if (resolved === REPOSITORY_ROOT || resolved.startsWith(`${REPOSITORY_ROOT}${path.sep}`)) {
    throw new Error('private_inside_checkout');
  }
  const realPath = realpathSync(resolved);
  if (realPath === REPOSITORY_ROOT || realPath.startsWith(`${REPOSITORY_ROOT}${path.sep}`)) {
    throw new Error('private_inside_checkout');
  }
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('private_permissions');
  }
  return JSON.parse(readFileSync(resolved, 'utf8'));
}

function readSupabaseLocalStatus() {
  const command = process.env.SUPABASE_CLI ?? 'supabase';
  const result = spawnSync(command, ['status', '--workdir', REPOSITORY_ROOT, '--output', 'json'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (result.error || result.status !== 0) throw new Error('supabase_status');
  const status = JSON.parse(result.stdout);
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    throw new Error('supabase_status_shape');
  }
  const apiOrigin = status.API_URL ?? status.api_url;
  const anonymousKey = status.ANON_KEY ?? status.anon_key;
  const adminKey = status.SERVICE_ROLE_KEY ?? status.service_role_key;
  if (
    typeof apiOrigin !== 'string' ||
    typeof anonymousKey !== 'string' ||
    typeof adminKey !== 'string' ||
    new URL(apiOrigin).origin !== EXPECTED_API_ORIGIN
  ) {
    throw new Error('supabase_status_shape');
  }
  return { apiOrigin: EXPECTED_API_ORIGIN, anonymousKey, adminKey };
}

function readDatabaseInputs() {
  const database = readPrivateJsonFile(
    'W4_DATABASE_INPUTS_FILE',
    '/home/ci/base-app-ci/w4/auth-spike-secrets/database-inputs.json',
  );
  if (
    !database ||
    typeof database !== 'object' ||
    typeof database.DATABASE_URL !== 'string' ||
    typeof database.DATABASE_CA_CERT !== 'string'
  ) {
    throw new Error('database_inputs_shape');
  }
  return { DATABASE_URL: database.DATABASE_URL, DATABASE_CA_CERT: database.DATABASE_CA_CERT };
}

function readAuthInput() {
  const auth = readPrivateJsonFile(
    'W4_AUTH_INPUTS_FILE',
    '/home/ci/base-app-ci/w4/auth-spike-secrets/auth-inputs.json',
  );
  if (
    !auth ||
    typeof auth !== 'object' ||
    typeof auth.email !== 'string' ||
    typeof auth.password !== 'string' ||
    typeof auth.userId !== 'string'
  ) {
    throw new Error('auth_inputs_shape');
  }
  return { email: auth.email, password: auth.password, userId: auth.userId };
}

function validateSafeResult(value) {
  if (!value || typeof value !== 'object' || typeof value.passed !== 'boolean') return null;
  if (!Array.isArray(value.checks)) return null;
  const checks = [];
  for (const check of value.checks) {
    if (
      !check ||
      typeof check !== 'object' ||
      typeof check.name !== 'string' ||
      !/^[a-z][a-z0-9_.-]{0,95}$/.test(check.name) ||
      typeof check.passed !== 'boolean'
    ) {
      return null;
    }
    const normalized = { name: check.name, passed: check.passed };
    if (Number.isSafeInteger(check.status)) normalized.status = check.status;
    if (typeof check.code === 'string' && /^[a-z][a-z0-9_.-]{0,95}$/.test(check.code)) {
      normalized.code = check.code;
    }
    if (Number.isSafeInteger(check.count) && check.count >= 0) normalized.count = check.count;
    checks.push(normalized);
  }
  const result = { passed: value.passed, checks };
  if (typeof value.failedCheck === 'string' && /^[a-z][a-z0-9_.-]{0,95}$/.test(value.failedCheck)) {
    result.failedCheck = value.failedCheck;
  }
  return result;
}

function runBundle(input) {
  const childEnvironment = {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'test',
    NO_COLOR: '1',
  };
  const result = spawnSync(process.execPath, [BUNDLE_PATH], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    input: JSON.stringify(input),
    timeout: 300_000,
    maxBuffer: 2 * 1024 * 1024,
    env: childEnvironment,
  });
  if (result.error) throw new Error('proof_runner');
  const reportLine = result.stdout.split(/\r?\n/u).find((line) => line.startsWith(RESULT_MARKER));
  if (!reportLine) throw new Error('proof_result_missing');
  const parsed = JSON.parse(reportLine.slice(RESULT_MARKER.length));
  const safe = validateSafeResult(parsed);
  if (!safe) throw new Error('proof_result_shape');
  emit(safe);
  if (result.status !== 0 || !safe.passed) process.exitCode = 1;
}

async function main() {
  const modes = process.argv
    .slice(2)
    .filter((argument) => argument === '--build-only' || argument === '--run-built');
  if (modes.length !== 1 || process.argv.length !== modes.length + 2) {
    fail('usage.mode_required');
    return;
  }
  if (modes[0] === '--build-only') {
    await buildBundle();
    emit({ built: true, output: BUNDLE_PATH });
    return;
  }
  if (process.env.W4_LIVE_PROOF_READY !== '1') {
    fail('preflight.ready_required');
    return;
  }

  try {
    assertBuiltBundle();
    const status = readSupabaseLocalStatus();
    const auth = readAuthInput();
    const database = readDatabaseInputs();
    runBundle({
      apiOrigin: status.apiOrigin,
      anonymousKey: status.anonymousKey,
      adminKey: status.adminKey,
      fixtureA: auth,
      database,
    });
  } catch {
    fail('preflight.failed');
  }
}

void main().catch(() => fail('orchestrator.failed'));
