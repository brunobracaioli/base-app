import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const projectId = 'app-base-w2-migration-verify';
const networkName = 'app-base-w2-migration-verify';
const databasePort = 54332;
const poolerPort = 54339;
const excludedServices = [
  'gotrue',
  'realtime',
  'storage-api',
  'imgproxy',
  'kong',
  'mailpit',
  'postgrest',
  'postgres-meta',
  'studio',
  'edge-runtime',
  'logflare',
  'vector',
].join(',');

function requireWorkspacePath(variable, fallback) {
  const value = process.env[variable] || fallback;
  if (!path.isAbsolute(value)) throw new Error(`invalid_${variable.toLowerCase()}`);
  return value;
}

const repositoryRoot = path.resolve(process.cwd());
const workRoot = requireWorkspacePath('APP_BASE_W2_ROOT', path.dirname(repositoryRoot));
const toolsRoot = requireWorkspacePath('APP_BASE_CI_TOOLS', '/home/ci/base-app-ci/tools');
const supabaseBin = path.join(toolsRoot, 'supabase-3.4.0', 'supabase');
const supabaseHome = path.join(workRoot, 'supabase-home');
const passwordPath = path.join(workRoot, 'db-password');
const configPath = path.join(repositoryRoot, 'supabase', 'config.toml');
const configBackupPath = path.join(workRoot, 'config.toml.original');
const registrySqlPath = path.join(repositoryRoot, 'supabase', '.temp', 'expected-registry.sql');
const dbContainer = `supabase_db_${projectId}`;

function command(program, args, { input, env = {} } = {}) {
  const result = spawnSync(program, args, {
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH,
      CI: '1',
      NO_COLOR: '1',
      DO_NOT_TRACK: '1',
      ...env,
    },
    input,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: `${result.stdout || ''}\n${result.stderr || ''}`,
    spawnError: result.error?.code || null,
  };
}

function sqlStates(output) {
  return [
    ...new Set(
      [
        ...output.matchAll(/(?:SQLSTATE|sqlstate)\s*[:= ]\s*([0-9A-Z]{5})/g),
        ...output.matchAll(/\bSQLSTATE\s+([0-9A-Z]{5})\b/g),
      ].map((match) => match[1]),
    ),
  ];
}

function errorFacts(output) {
  return {
    errorLineCount: output.split(/\r?\n/).filter((line) => /\b(error|failed|fatal)\b/i.test(line))
      .length,
    sqlStates: sqlStates(output),
    migrationFiles: [
      ...new Set([...output.matchAll(/\b(\d{14}_[a-z0-9_-]+\.sql)\b/g)].map((match) => match[1])),
    ],
    tapPassed: output.split(/\r?\n/).filter((line) => /^\s*ok\s+\d+\b/.test(line)).length,
    tapFailed: output.split(/\r?\n/).filter((line) => /^\s*not ok\s+\d+\b/.test(line)).length,
  };
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function databasePassword() {
  if (!existsSync(passwordPath)) {
    mkdirSync(workRoot, { recursive: true, mode: 0o700 });
    writeFileSync(passwordPath, randomBytes(32).toString('base64url'), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  }
  const mode = statSync(passwordPath).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error('database_password_permissions');
  const value = readFileSync(passwordPath, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(value)) throw new Error('database_password_format');
  return value;
}

function prepareConfig() {
  const current = readFileSync(configPath, 'utf8');
  if (current.includes(`project_id = "${projectId}"`)) {
    if (!existsSync(configBackupPath)) throw new Error('config_backup_missing');
    return;
  }
  if (!current.includes('project_id = "base-app"')) throw new Error('unexpected_config_project_id');
  if (existsSync(configBackupPath)) throw new Error('config_backup_already_exists');

  const modified = current
    .replace('project_id = "base-app"', `project_id = "${projectId}"`)
    .replace(
      '[db.pooler]',
      `[db]\nport = ${databasePort}\npassword = "env(SUPABASE_DB_PASSWORD)"\n\n[db.pooler]`,
    )
    .replace(/^port = 54329$/m, `port = ${poolerPort}`);
  if (modified === current || !modified.includes(`port = ${databasePort}`)) {
    throw new Error('scratch_config_edit_failed');
  }

  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  writeFileSync(configBackupPath, current, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  writeFileSync(configPath, modified, { encoding: 'utf8', mode: 0o600 });
}

function restoreConfig() {
  if (!existsSync(configBackupPath)) return true;
  writeFileSync(configPath, readFileSync(configBackupPath, 'utf8'), {
    encoding: 'utf8',
    mode: 0o600,
  });
  rmSync(configBackupPath, { force: true });
  return true;
}

function dockerNames(filter) {
  const result = command('docker', [
    'ps',
    '-a',
    '--filter',
    `name=${filter}`,
    '--format',
    '{{.Names}}',
  ]);
  if (result.exitCode !== 0) throw new Error('docker_preflight_failed');
  return result.output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function networkNames() {
  const result = command('docker', [
    'network',
    'ls',
    '--filter',
    `name=${networkName}`,
    '--format',
    '{{.Name}}',
  ]);
  if (result.exitCode !== 0) throw new Error('docker_network_preflight_failed');
  return result.output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

async function portIsFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

async function preflight() {
  const occupied = [];
  for (const port of [databasePort, poolerPort]) {
    if (!(await portIsFree(port))) occupied.push(port);
  }
  const existingContainers = dockerNames(projectId);
  const existingNetworks = networkNames();
  if (occupied.length || existingContainers.length || existingNetworks.length) {
    throw new Error('owned_resource_preflight_failed');
  }
  return { occupiedPorts: occupied, existingContainers, existingNetworks };
}

function ownedPortFacts() {
  const result = command('docker', [
    'ps',
    '--filter',
    `name=${projectId}`,
    '--format',
    '{{.Names}}\t{{.Ports}}',
  ]);
  if (result.exitCode !== 0) throw new Error('owned_container_readback_failed');
  const rows = result.output.split(/\r?\n/).filter((line) => line.includes('supabase_'));
  const bindings = rows.flatMap((line) => {
    const columns = line.split('\t');
    return (columns[1] || '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.includes('->'));
  });
  const loopbackOnly =
    bindings.length > 0 &&
    bindings.every((binding) => binding.split('->')[0].startsWith('127.0.0.1:'));
  return {
    ownedContainers: rows.length,
    publishedPortCount: bindings.length,
    loopbackOnly,
    publishedPorts: bindings.map((binding) => Number(binding.split('->')[0].split(':').at(-1))),
  };
}

function createNetwork() {
  const result = command('docker', [
    'network',
    'create',
    '--driver',
    'bridge',
    '--opt',
    'com.docker.network.bridge.host_binding_ipv4=127.0.0.1',
    networkName,
  ]);
  if (result.exitCode !== 0) throw new Error('owned_network_create_failed');
}

function supabase(args, password) {
  return command(supabaseBin, [...args, '--workdir', repositoryRoot, '--network-id', networkName], {
    env: {
      SUPABASE_HOME: supabaseHome,
      SUPABASE_DB_PASSWORD: password,
      PGPASSWORD: password,
    },
  });
}

function effectiveDatabasePassword(configuredPassword) {
  const result = supabase(['status', '--output', 'json'], configuredPassword);
  if (result.exitCode !== 0) throw new Error('database_status_failed');

  let status;
  try {
    status = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error('database_status_json_invalid');
  }
  if (status === null || typeof status !== 'object' || Array.isArray(status))
    throw new Error('database_status_shape_invalid');
  if (typeof status.DB_URL !== 'string') throw new Error('database_status_url_missing');

  let databaseUrl;
  let username;
  let password;
  try {
    databaseUrl = new URL(status.DB_URL);
    username = decodeURIComponent(databaseUrl.username);
    password = decodeURIComponent(databaseUrl.password);
  } catch {
    throw new Error('database_status_url_invalid');
  }

  if (
    !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
    !['127.0.0.1', 'localhost'].includes(databaseUrl.hostname) ||
    databaseUrl.port !== String(databasePort) ||
    username !== 'postgres' ||
    databaseUrl.pathname !== '/postgres' ||
    databaseUrl.search !== '' ||
    databaseUrl.hash !== ''
  ) {
    throw new Error('database_status_url_outside_owned_local_target');
  }
  if (password.length === 0 || /[\u0000\r\n]/.test(password))
    throw new Error('database_status_password_invalid');

  return password;
}

function stage(stageName, commandResult) {
  emit({
    stage: stageName,
    exitCode: commandResult.exitCode,
    spawnError: commandResult.spawnError,
    ...errorFacts(commandResult.output),
  });
  if (commandResult.exitCode !== 0) throw new Error(`${stageName}_failed`);
}

function start(password) {
  prepareConfig();
  createNetwork();
  stage('supabase_start', supabase(['start', '--exclude', excludedServices], password));
  const ports = ownedPortFacts();
  emit({ stage: 'published_port_readback', ...ports });
  if (!ports.loopbackOnly) throw new Error('non_loopback_binding_detected');
}

function reset(password) {
  stage('database_reset', supabase(['db', 'reset', '--no-seed'], password));
}

function installRegistryFixtures(password) {
  const generator = command(process.execPath, [
    '--experimental-strip-types',
    path.join(repositoryRoot, 'packages/tooling/src/db/generate-pgtap-fixtures.ts'),
  ]);
  stage('registry_fixture_generation', generator);
  const sql =
    readFileSync(registrySqlPath, 'utf8') +
    '\n' +
    readFileSync(path.join(repositoryRoot, 'supabase/tools/setup-pgtap.sql'), 'utf8');
  const result = command(
    'docker',
    [
      'exec',
      '-i',
      '-u',
      'postgres',
      dbContainer,
      'psql',
      '-U',
      'supabase_admin',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
    ],
    { input: sql, env: { SUPABASE_DB_PASSWORD: password } },
  );
  stage('registry_fixture_load', result);
}

function testDb(password) {
  const effectivePassword = effectiveDatabasePassword(password);
  installRegistryFixtures(effectivePassword);
  const requestedPaths = process.argv.slice(3);
  const allowedTestNames = new Set([
    'w2_catalog_privileges.test.sql',
    'w2_audit.test.sql',
    'w2_idempotency.test.sql',
    'w2_ops_purge_expired.test.sql',
    'w2_ops_signals.test.sql',
    'w2_signup_hook.test.sql',
  ]);
  const testPaths = requestedPaths.map((name) => {
    if (!allowedTestNames.has(name)) throw new Error('unapproved_test_path');
    return `supabase/tests/${name}`;
  });
  // The test fixture administrator can SET each role under test. Migrations
  // still run as postgres, so managed-provider grant restrictions stay visible.
  stage(
    'pgtap',
    supabase(
      [
        'test',
        'db',
        ...testPaths,
        '--db-url',
        `postgresql://supabase_admin@127.0.0.1:${databasePort}/postgres`,
      ],
      effectivePassword,
    ),
  );
  return effectivePassword;
}

function dropRegistryFixtures(password) {
  const result = command(
    'docker',
    [
      'exec',
      '-i',
      '-u',
      'postgres',
      dbContainer,
      'psql',
      '-U',
      'supabase_admin',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
    ],
    {
      input: 'drop schema if exists test_support cascade;\n',
      env: { SUPABASE_DB_PASSWORD: password },
    },
  );
  return result.exitCode === 0;
}

function stop(password) {
  let stopResult = { exitCode: 0, output: '', spawnError: null };
  if (dockerNames(projectId).length > 0) {
    stopResult = supabase(['stop', '--project-id', projectId, '--no-backup'], password);
  }
  const removed = command('docker', ['network', 'rm', networkName]);
  restoreConfig();
  rmSync(passwordPath, { force: true });
  rmSync(registrySqlPath, { force: true });
  rmSync(supabaseHome, { recursive: true, force: true });
  return {
    stopExitCode: stopResult.exitCode,
    networkRemoved: removed.exitCode === 0 || !networkNames().includes(networkName),
    configRestored: !existsSync(configBackupPath),
    passwordFileRemoved: !existsSync(passwordPath),
    fixtureFileRemoved: !existsSync(registrySqlPath),
    supabaseHomeRemoved: !existsSync(supabaseHome),
  };
}

async function main() {
  const mode = process.argv[2];
  if (!['start', 'reset', 'test', 'stop', 'full'].includes(mode)) {
    throw new Error('invalid_mode');
  }
  if (mode === 'start' || mode === 'full') {
    const facts = await preflight();
    emit({ stage: 'preflight', ...facts, portsChecked: [databasePort, poolerPort] });
  }
  const password = mode === 'stop' && !existsSync(passwordPath) ? '' : databasePassword();
  let fixturePassword = password;

  try {
    if (mode === 'start' || mode === 'full') start(password);
    if (mode === 'reset' || mode === 'full') reset(password);
    if (mode === 'test' || mode === 'full') fixturePassword = testDb(password);
    if (mode === 'stop') {
      const cleanup = stop(password);
      emit({ stage: 'cleanup', ...cleanup });
      if (cleanup.stopExitCode !== 0 || !cleanup.networkRemoved) {
        throw new Error('cleanup_incomplete');
      }
    }
    if (mode === 'full') {
      const fixturesRemoved = dropRegistryFixtures(fixturePassword);
      const cleanup = stop(password);
      emit({ stage: 'cleanup', fixturesRemoved, ...cleanup });
      if (!fixturesRemoved || cleanup.stopExitCode !== 0 || !cleanup.networkRemoved) {
        throw new Error('cleanup_incomplete');
      }
    }
    emit({ stage: 'complete', ok: true });
  } catch (error) {
    emit({ stage: 'failed', errorCode: error instanceof Error ? error.message : 'unknown_error' });
    if (mode === 'full') {
      emit({ stage: 'cleanup_after_failure', ...stop(password) });
    }
    throw error;
  }
}

main().catch(() => {
  process.exitCode = 1;
});
