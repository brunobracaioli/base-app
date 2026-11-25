import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { scannerVersions } from './tool-versions.ts';
import {
  createChildEnvironment,
  executeLocalCi,
  type CiGate,
  type CiVersionCheck,
} from './runner.ts';

const root = resolve(import.meta.dirname, '../../../../');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  packageManager: string;
};
const nodePin = readFileSync(join(root, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
const pnpmPin = /^pnpm@([^+]+)(?:\+.*)?$/.exec(packageJson.packageManager)?.[1] ?? '';

if (!pnpmPin) throw new Error('packageManager must pin pnpm in package.json.');

const binaries = {
  pnpm: process.env.CI_LOCAL_PNPM_BIN ?? 'pnpm',
  semgrep: process.env.CI_LOCAL_SEMGREP_BIN ?? 'semgrep',
  gitleaks: process.env.CI_LOCAL_GITLEAKS_BIN ?? 'gitleaks',
  osvScanner: process.env.CI_LOCAL_OSV_SCANNER_BIN ?? 'osv-scanner',
  zizmor: process.env.CI_LOCAL_ZIZMOR_BIN ?? 'zizmor',
} as const;

interface CommandOutput {
  status: number | null;
  stdout: string;
  stderr: string;
}

function probe(executable: string, args: string[], env: NodeJS.ProcessEnv): CommandOutput {
  const result = spawnSync(executable, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function parseVersion(output: string): string | null {
  return /(?:^|\D)(\d+\.\d+\.\d+)(?:$|\D)/m.exec(output)?.[1] ?? null;
}

function checkVersion(
  name: string,
  command: string,
  executable: string,
  args: string[],
  expected: string,
  env: NodeJS.ProcessEnv,
): CiVersionCheck {
  const output = probe(executable, args, env);
  const exitCode = output.status ?? 127;
  const observed = parseVersion(`${output.stdout}\n${output.stderr}`);
  return {
    name,
    command,
    expected,
    observed,
    exitCode,
    passed: exitCode === 0 && observed === expected,
  };
}

function createVersionChecks(env: NodeJS.ProcessEnv): CiVersionCheck[] {
  return [
    {
      name: 'node',
      command: 'node --version',
      expected: nodePin,
      observed: process.version.replace(/^v/, ''),
      exitCode: 0,
      passed: process.version.replace(/^v/, '') === nodePin,
    },
    checkVersion('pnpm', 'pnpm --version', binaries.pnpm, ['--version'], pnpmPin, env),
    checkVersion(
      'semgrep',
      'semgrep --version',
      binaries.semgrep,
      ['--version'],
      scannerVersions.semgrep,
      env,
    ),
    checkVersion(
      'gitleaks',
      'gitleaks version',
      binaries.gitleaks,
      ['version'],
      scannerVersions.gitleaks,
      env,
    ),
    checkVersion(
      'osv-scanner',
      'osv-scanner --version',
      binaries.osvScanner,
      ['--version'],
      scannerVersions.osvScanner,
      env,
    ),
    checkVersion(
      'zizmor',
      'zizmor --version',
      binaries.zizmor,
      ['--version'],
      scannerVersions.zizmor,
      env,
    ),
  ];
}

function pnpmGate(id: string, args: string[]): CiGate {
  return { id, command: 'pnpm', executable: binaries.pnpm, args };
}

function createGates(): CiGate[] {
  const targets = ['apps', 'packages', 'supabase'].filter((path) => existsSync(join(root, path)));
  if (targets.length === 0) throw new Error('No source directories are available for Semgrep.');

  return [
    pnpmGate('install', ['install', '--frozen-lockfile']),
    pnpmGate('workspace', ['turbo', 'run', 'lint', 'typecheck', 'test']),
    pnpmGate('architecture', ['architecture:check']),
    pnpmGate('format', ['format:check']),
    pnpmGate('openapi-generate', ['contracts:openapi']),
    {
      id: 'openapi-drift',
      command: 'git',
      executable: 'git',
      args: ['diff', '--exit-code', 'HEAD', '--', 'docs/reference/openapi.yaml'],
    },
    pnpmGate('supabase-config-generate', ['supabase:config']),
    {
      id: 'supabase-config-drift',
      command: 'git',
      executable: 'git',
      args: ['diff', '--exit-code', 'HEAD', '--', 'supabase/config.toml'],
    },
    pnpmGate('supabase-config-invariants', ['supabase:config:check']),
    pnpmGate('migration-lint', ['db:lint-migrations']),
    pnpmGate('vercel-config', ['vercel:check']),
    {
      id: 'semgrep-tests-typescript',
      command: 'semgrep',
      executable: binaries.semgrep,
      args: ['--test', '--config', '.semgrep/base-app.yml', '.semgrep/tests/base-app.ts'],
    },
    {
      id: 'semgrep-tests-sql',
      command: 'semgrep',
      executable: binaries.semgrep,
      args: ['--test', '--config', '.semgrep/sql.yml', '.semgrep/tests/sql-rules.sql'],
    },
    {
      id: 'semgrep-scan',
      command: 'semgrep',
      executable: binaries.semgrep,
      args: ['scan', '--error', '--config', '.semgrep', ...targets],
    },
    {
      id: 'gitleaks-history',
      command: 'gitleaks',
      executable: binaries.gitleaks,
      args: ['git', '--redact', '--exit-code', '1'],
    },
    {
      id: 'osv-scan',
      command: 'osv-scanner',
      executable: binaries.osvScanner,
      args: ['scan', 'source', '--recursive', '.'],
    },
    {
      id: 'zizmor-github-config',
      command: 'zizmor',
      executable: binaries.zizmor,
      args: [
        '--collect',
        'all',
        '--strict-collection',
        '--no-online-audits',
        '--cache-dir',
        '.artifacts/ci/zizmor-cache',
        '.github',
      ],
    },
    {
      id: 'zizmor-unsafe-fixture',
      command: 'zizmor',
      executable: binaries.zizmor,
      args: [
        '--strict-collection',
        '--no-online-audits',
        '--cache-dir',
        '.artifacts/ci/zizmor-cache',
        'packages/tooling/src/security/fixtures/zizmor/pull-request-target.yml',
      ],
      expectedExitCode: 14,
    },
  ];
}

async function main(): Promise<number> {
  const artifactsDirectory = join(root, '.artifacts', 'ci');
  mkdirSync(artifactsDirectory, { recursive: true, mode: 0o700 });
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'base-app-ci-'));
  const childEnvironment = createChildEnvironment(root, temporaryDirectory);
  const checks = createVersionChecks(childEnvironment);
  const receipt = await executeLocalCi({
    root,
    artifactsDirectory,
    childEnvironment,
    toolchainChecks: checks,
    toolchainPassed: checks.every((check) => check.passed),
    gates: createGates(),
  });

  process.stdout.write(
    `${receipt.result.toUpperCase()}: ${receipt.receiptPath} (HEAD ${receipt.provenance.headSha}, ${receipt.provenance.dirtyAtStart ? 'dirty' : 'clean'}, attestable=${receipt.provenance.attestableCommit})\n`,
  );
  if (receipt.failure) process.stderr.write(`FAIL: ${receipt.failure}\n`);
  rmSync(temporaryDirectory, { recursive: true, force: true });
  return receipt.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main();
}
