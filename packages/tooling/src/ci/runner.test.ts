import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createChildEnvironment,
  executeLocalCi,
  type CiGate,
  type CiProvenance,
} from './runner.ts';

const temporaryDirectories: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, '../../../../');

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'base-app-ci-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function provenance(overrides: Partial<CiProvenance> = {}): CiProvenance {
  return {
    headSha: '0123456789abcdef0123456789abcdef01234567',
    headTreeSha: '89abcdef0123456789abcdef0123456789abcdef',
    dirty: false,
    worktreeDigest: 'a'.repeat(64),
    ...overrides,
  };
}

const versionChecks = [
  {
    name: 'node',
    command: 'node --version',
    expected: '24.22.3',
    observed: '24.22.3',
    exitCode: 0,
    passed: true,
  },
];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('executeLocalCi', () => {
  it('does not forward ambient credential or HOME variables to subprocesses', () => {
    vi.stubEnv('PATH', '/tools');
    vi.stubEnv('COREPACK_HOME', '/tmp/corepack');
    vi.stubEnv('HOME', '/private/home');
    vi.stubEnv('GITHUB_TOKEN', 'credential-sentinel');
    vi.stubEnv('OPENAI_API_KEY', 'credential-sentinel');

    const environment = createChildEnvironment('/repo', '/tmp/ci-run');

    expect(environment).toMatchObject({
      PATH: '/tools',
      PWD: '/repo',
      COREPACK_HOME: '/tmp/corepack',
    });
    expect(environment).not.toHaveProperty('HOME');
    expect(environment).not.toHaveProperty('GITHUB_TOKEN');
    expect(environment).not.toHaveProperty('OPENAI_API_KEY');
    expect(JSON.stringify(environment)).not.toContain('credential-sentinel');
  });

  it('keeps the checkout free of executable GitHub Actions workflows', () => {
    const workflowsDirectory = join(repositoryRoot, '.github', 'workflows');
    const workflowFiles = existsSync(workflowsDirectory)
      ? readdirSync(workflowsDirectory).filter((path) => /\.ya?ml$/i.test(path))
      : [];

    expect(workflowFiles).toEqual([]);
  });

  it('stops at the first failing gate and persists a failed receipt', async () => {
    const directory = createDirectory();
    const current = provenance();
    const executed: string[] = [];
    const gates: CiGate[] = [
      { id: 'first', command: 'tool', executable: 'tool', args: ['first'] },
      { id: 'second', command: 'tool', executable: 'tool', args: ['second'] },
    ];
    const receipt = await executeLocalCi({
      root: directory,
      gates,
      childEnvironment: {},
      toolchainChecks: versionChecks,
      toolchainPassed: true,
      artifactsDirectory: join(directory, '.artifacts', 'ci'),
      dependencies: {
        now: vi.fn(() => new Date('2026-11-24T12:00:00.000Z')),
        readProvenance: vi.fn(() => current),
        runCommand: vi.fn((_executable, args) => {
          executed.push(args[0] ?? '');
          return { status: 7, signal: null, stdout: 'failed', stderr: '' };
        }),
      },
    });

    expect(executed).toEqual(['first']);
    expect(receipt.result).toBe('failed');
    expect(receipt.gates).toHaveLength(1);
    expect(receipt.gates[0]?.exitCode).toBe(7);
    expect(receipt.gates[0]?.logPath).toMatch(/^\.artifacts\/ci\//);
    expect(JSON.parse(readFileSync(join(directory, receipt.receiptPath), 'utf8'))).toMatchObject({
      result: 'failed',
      exitCode: 1,
    });
  });

  it('does not attest a successful run that started from a dirty checkout', async () => {
    const directory = createDirectory();
    const dirty = provenance({ dirty: true, worktreeDigest: 'b'.repeat(64) });
    const receipt = await executeLocalCi({
      root: directory,
      gates: [{ id: 'only', command: 'tool', executable: 'tool', args: [] }],
      childEnvironment: {},
      toolchainChecks: versionChecks,
      toolchainPassed: true,
      artifactsDirectory: join(directory, '.artifacts', 'ci'),
      dependencies: {
        now: vi.fn(() => new Date('2026-11-24T12:00:00.000Z')),
        readProvenance: vi.fn(() => dirty),
        runCommand: vi.fn(() => ({ status: 0, signal: null, stdout: '', stderr: '' })),
      },
    });

    expect(receipt.result).toBe('passed');
    expect(receipt.provenance.dirtyAtStart).toBe(true);
    expect(receipt.provenance.attestableCommit).toBe(false);
  });

  it('attests the exact clean commit and tree after all gates pass', async () => {
    const directory = createDirectory();
    const clean = provenance();
    const receipt = await executeLocalCi({
      root: directory,
      gates: [{ id: 'only', command: 'tool', executable: 'tool', args: [] }],
      childEnvironment: {},
      toolchainChecks: versionChecks,
      toolchainPassed: true,
      artifactsDirectory: join(directory, '.artifacts', 'ci'),
      dependencies: {
        now: vi.fn(() => new Date('2026-11-24T12:00:00.000Z')),
        readProvenance: vi.fn(() => clean),
        runCommand: vi.fn(() => ({ status: 0, signal: null, stdout: '', stderr: '' })),
      },
    });

    expect(receipt.result).toBe('passed');
    expect(receipt.provenance).toMatchObject({
      headSha: clean.headSha,
      headTreeSha: clean.headTreeSha,
      unchangedDuringRun: true,
      attestableCommit: true,
    });
  });

  it('stops when the worktree changes during a gate', async () => {
    const directory = createDirectory();
    const original = provenance();
    const changed = provenance({ worktreeDigest: 'c'.repeat(64), dirty: true });
    const reads = [original, original, changed, changed];
    const readProvenance = vi.fn(() => reads.shift() ?? changed);
    const runCommand = vi.fn(() => ({ status: 0, signal: null, stdout: '', stderr: '' }));
    const receipt = await executeLocalCi({
      root: directory,
      gates: [
        { id: 'first', command: 'tool', executable: 'tool', args: [] },
        { id: 'second', command: 'tool', executable: 'tool', args: [] },
      ],
      childEnvironment: {},
      toolchainChecks: versionChecks,
      toolchainPassed: true,
      artifactsDirectory: join(directory, '.artifacts', 'ci'),
      dependencies: {
        now: vi.fn(() => new Date('2026-11-24T12:00:00.000Z')),
        readProvenance,
        runCommand,
      },
    });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(receipt.result).toBe('failed');
    expect(receipt.provenance.unchangedDuringRun).toBe(false);
    expect(receipt.provenance.attestableCommit).toBe(false);
  });

  it('treats an unexpectedly accepted unsafe fixture as a failure', async () => {
    const directory = createDirectory();
    const current = provenance();
    const receipt = await executeLocalCi({
      root: directory,
      gates: [
        {
          id: 'unsafe-fixture',
          command: 'zizmor',
          executable: 'zizmor',
          args: ['fixture.yml'],
          expectedExitCode: 14,
        },
      ],
      childEnvironment: {},
      toolchainChecks: versionChecks,
      toolchainPassed: true,
      artifactsDirectory: join(directory, '.artifacts', 'ci'),
      dependencies: {
        now: vi.fn(() => new Date('2026-11-24T12:00:00.000Z')),
        readProvenance: vi.fn(() => current),
        runCommand: vi.fn(() => ({ status: 0, signal: null, stdout: '', stderr: '' })),
      },
    });

    expect(receipt.result).toBe('failed');
    expect(receipt.gates[0]?.expectedExitCode).toBe(14);
    expect(receipt.gates[0]?.exitCode).toBe(0);
  });
});
