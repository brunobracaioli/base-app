import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

export interface CiGate {
  id: string;
  command: string;
  executable: string;
  args: string[];
  expectedExitCode?: number;
}

export interface CiCommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  errorCode?: string;
  stdout: string;
  stderr: string;
}

export interface CiProvenance {
  headSha: string;
  headTreeSha: string;
  dirty: boolean;
  worktreeDigest: string;
}

export interface CiCommandContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface CiRunnerDependencies {
  runCommand: (executable: string, args: string[], context: CiCommandContext) => CiCommandResult;
  readProvenance: (root: string, context: CiCommandContext) => CiProvenance;
  now: () => Date;
}

export interface CiGateResult {
  id: string;
  command: string;
  args: string[];
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  expectedExitCode: number;
  passed: boolean;
  logPath: string;
}

export interface CiVersionCheck {
  name: string;
  command: string;
  expected: string;
  observed: string | null;
  exitCode: number;
  passed: boolean;
}

export interface CiReceipt {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  result: 'passed' | 'failed';
  exitCode: number;
  receiptPath: string;
  provenance: {
    headSha: string;
    headTreeSha: string;
    dirtyAtStart: boolean;
    dirtyAtEnd: boolean;
    worktreeDigestAtStart: string;
    worktreeDigestAtEnd: string;
    unchangedDuringRun: boolean;
    attestableCommit: boolean;
  };
  toolchain: CiVersionCheck[];
  gates: CiGateResult[];
  failure: string | null;
}

export interface ExecuteCiOptions {
  root: string;
  gates: CiGate[];
  childEnvironment: NodeJS.ProcessEnv;
  toolchainChecks: CiVersionCheck[];
  toolchainPassed: boolean;
  artifactsDirectory?: string;
  dependencies?: Partial<CiRunnerDependencies>;
}

const defaultTimeoutMs = 30 * 60 * 1000;

function defaultRunCommand(
  executable: string,
  args: string[],
  context: CiCommandContext,
): CiCommandResult {
  const result = spawnSync(executable, args, {
    cwd: context.cwd,
    env: context.env,
    encoding: 'utf8',
    timeout: context.timeoutMs,
    maxBuffer: 50 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const spawnError = result.error as NodeJS.ErrnoException | undefined;

  return {
    status: result.status,
    signal: result.signal,
    ...(spawnError?.code ? { errorCode: spawnError.code } : {}),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function commandExitCode(result: CiCommandResult): number {
  if (result.status !== null) return result.status;
  if (result.signal) return 128;
  return 127;
}

function getWorktreeDigest(root: string, context: CiCommandContext): string {
  const hash = createHash('sha256');
  const diff = defaultRunCommand('git', ['diff', '--binary', 'HEAD', '--'], context);
  if (commandExitCode(diff) !== 0) throw new Error('Unable to inspect tracked worktree changes.');
  hash.update(diff.stdout);

  const untracked = defaultRunCommand(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    context,
  );
  if (commandExitCode(untracked) !== 0)
    throw new Error('Unable to inspect untracked worktree files.');

  const paths = untracked.stdout.split('\0').filter(Boolean).sort();
  for (const path of paths) {
    const absolutePath = resolve(root, path);
    const metadata = lstatSync(absolutePath);
    hash.update(path);
    hash.update('\0');
    hash.update(`${metadata.mode.toString(8)}\0`);
    if (metadata.isSymbolicLink()) {
      hash.update('symlink\0');
      hash.update(readlinkSync(absolutePath));
    } else if (metadata.isFile()) {
      hash.update('file\0');
      hash.update(readFileSync(absolutePath));
    } else if (metadata.isDirectory()) {
      hash.update('directory\0');
      hash.update(readdirSync(absolutePath).sort().join('\0'));
    } else {
      hash.update('other\0');
    }
    hash.update('\0');
  }

  return hash.digest('hex');
}

export function readGitProvenance(root: string, context: CiCommandContext): CiProvenance {
  const headResult = defaultRunCommand('git', ['rev-parse', 'HEAD'], context);
  const treeResult = defaultRunCommand('git', ['rev-parse', 'HEAD^{tree}'], context);
  const statusResult = defaultRunCommand(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    context,
  );
  for (const result of [headResult, treeResult, statusResult]) {
    if (commandExitCode(result) !== 0) throw new Error('Unable to inspect Git provenance.');
  }

  const headSha = headResult.stdout.trim();
  const headTreeSha = treeResult.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(headSha) || !/^[0-9a-f]{40,64}$/i.test(headTreeSha)) {
    throw new Error('Git returned an invalid commit or tree identifier.');
  }

  return {
    headSha,
    headTreeSha,
    dirty: statusResult.stdout.trim().length > 0,
    worktreeDigest: getWorktreeDigest(root, context),
  };
}

function sameProvenance(left: CiProvenance, right: CiProvenance): boolean {
  return (
    left.headSha === right.headSha &&
    left.headTreeSha === right.headTreeSha &&
    left.dirty === right.dirty &&
    left.worktreeDigest === right.worktreeDigest
  );
}

function formatGateLog(gate: CiGate, result: CiCommandResult): string {
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const spawnFailure = result.errorCode ? `\nCommand spawn failed: ${result.errorCode}\n` : '';
  return [
    `$ ${JSON.stringify([gate.command, ...gate.args])}`,
    `exitCode: ${commandExitCode(result)}`,
    spawnFailure,
    output,
  ]
    .filter(Boolean)
    .join('\n')
    .concat('\n');
}

function writeReceipt(receiptPath: string, receipt: CiReceipt): void {
  const temporaryPath = `${receiptPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, receiptPath);
}

function buildReceiptProvenance(
  initial: CiProvenance,
  final: CiProvenance,
  succeeded: boolean,
): CiReceipt['provenance'] {
  const unchangedDuringRun = sameProvenance(initial, final);
  return {
    headSha: initial.headSha,
    headTreeSha: initial.headTreeSha,
    dirtyAtStart: initial.dirty,
    dirtyAtEnd: final.dirty,
    worktreeDigestAtStart: initial.worktreeDigest,
    worktreeDigestAtEnd: final.worktreeDigest,
    unchangedDuringRun,
    attestableCommit:
      succeeded &&
      unchangedDuringRun &&
      !initial.dirty &&
      !final.dirty &&
      initial.headSha === final.headSha &&
      initial.headTreeSha === final.headTreeSha,
  };
}

export async function executeLocalCi(options: ExecuteCiOptions): Promise<CiReceipt> {
  const root = resolve(options.root);
  const artifactsRoot = resolve(options.artifactsDirectory ?? join(root, '.artifacts', 'ci'));
  mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 });
  const runTimestamp = (options.dependencies?.now ?? (() => new Date()))()
    .toISOString()
    .replaceAll(':', '-')
    .replaceAll('.', '-');
  const runDirectory = mkdtempSync(join(artifactsRoot, `${runTimestamp}-`));
  const logsDirectory = join(runDirectory, 'logs');
  mkdirSync(logsDirectory, { mode: 0o700 });
  const runId = basename(runDirectory);
  const receiptPath = join(runDirectory, 'receipt.json');
  const relativeReceiptPath = relative(root, receiptPath).replaceAll('\\', '/');
  const startedAt = (options.dependencies?.now ?? (() => new Date()))().toISOString();
  const context: CiCommandContext = {
    cwd: root,
    env: options.childEnvironment,
    timeoutMs: defaultTimeoutMs,
  };
  const dependencies: CiRunnerDependencies = {
    runCommand: options.dependencies?.runCommand ?? defaultRunCommand,
    readProvenance: options.dependencies?.readProvenance ?? readGitProvenance,
    now: options.dependencies?.now ?? (() => new Date()),
  };

  let initialProvenance: CiProvenance;
  let finalProvenance: CiProvenance;
  let failure: string | null = null;
  let stateChanged = false;
  const gateResults: CiGateResult[] = [];

  try {
    initialProvenance = dependencies.readProvenance(root, context);
    finalProvenance = initialProvenance;
  } catch {
    initialProvenance = {
      headSha: 'unavailable',
      headTreeSha: 'unavailable',
      dirty: true,
      worktreeDigest: 'unavailable',
    };
    finalProvenance = initialProvenance;
    failure = 'Unable to establish Git provenance.';
  }

  if (!failure && !options.toolchainPassed) {
    failure = 'The required Node, pnpm, or scanner version is missing or does not match its pin.';
  }

  if (!failure) {
    for (const gate of options.gates) {
      let before: CiProvenance;
      try {
        before = dependencies.readProvenance(root, context);
      } catch {
        failure = 'Unable to recheck Git provenance before a gate.';
        stateChanged = true;
        break;
      }
      if (!sameProvenance(initialProvenance, before)) {
        failure = 'Git provenance changed during CI execution.';
        stateChanged = true;
        finalProvenance = before;
        break;
      }

      const gateStartedAt = dependencies.now().toISOString();
      let commandResult: CiCommandResult;
      try {
        commandResult = dependencies.runCommand(gate.executable, gate.args, context);
      } catch (error) {
        commandResult = {
          status: null,
          signal: null,
          errorCode: error instanceof Error ? error.name : 'UNKNOWN',
          stdout: '',
          stderr: '',
        };
      }

      const exitCode = commandExitCode(commandResult);
      const expectedExitCode = gate.expectedExitCode ?? 0;
      const passed = exitCode === expectedExitCode;
      const logPath = join(logsDirectory, `${gate.id}.log`);
      writeFileSync(logPath, formatGateLog(gate, commandResult), { mode: 0o600 });
      const gateResult: CiGateResult = {
        id: gate.id,
        command: gate.command,
        args: gate.args,
        startedAt: gateStartedAt,
        finishedAt: dependencies.now().toISOString(),
        exitCode,
        expectedExitCode,
        passed,
        logPath: relative(root, logPath).replaceAll('\\', '/'),
      };
      gateResults.push(gateResult);

      try {
        finalProvenance = dependencies.readProvenance(root, context);
      } catch {
        failure = 'Unable to recheck Git provenance after a gate.';
        stateChanged = true;
        break;
      }
      if (!sameProvenance(initialProvenance, finalProvenance)) {
        failure = 'Git provenance changed during CI execution.';
        stateChanged = true;
        break;
      }
      if (!passed) {
        failure = `Gate "${gate.id}" returned ${exitCode}; expected ${expectedExitCode}.`;
        break;
      }
    }
  }

  try {
    finalProvenance = dependencies.readProvenance(root, context);
  } catch {
    stateChanged = true;
    failure ??= 'Unable to establish final Git provenance.';
  }

  if (!sameProvenance(initialProvenance, finalProvenance)) {
    stateChanged = true;
    failure ??= 'Git provenance changed during CI execution.';
  }

  const gatesPassed =
    gateResults.length === options.gates.length && gateResults.every((gate) => gate.passed);
  const result =
    !failure && !stateChanged && options.toolchainPassed && gatesPassed ? 'passed' : 'failed';
  const receipt: CiReceipt = {
    schemaVersion: 1,
    runId,
    startedAt,
    finishedAt: dependencies.now().toISOString(),
    result,
    exitCode: result === 'passed' ? 0 : 1,
    receiptPath: relativeReceiptPath,
    provenance: buildReceiptProvenance(initialProvenance, finalProvenance, result === 'passed'),
    toolchain: options.toolchainChecks,
    gates: gateResults,
    failure,
  };
  writeReceipt(receiptPath, receipt);
  return receipt;
}

export function createChildEnvironment(
  root: string,
  temporaryDirectory: string,
): NodeJS.ProcessEnv {
  const corepackHome = process.env.COREPACK_HOME ?? join(tmpdir(), 'base-app-corepack');
  const path = process.env.PATH;
  return {
    ...(path ? { PATH: path } : {}),
    PWD: root,
    COREPACK_HOME: corepackHome,
    CI: '1',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    SEMGREP_SETTINGS_FILE: join(temporaryDirectory, 'semgrep-settings.yml'),
    SEMGREP_LOG_FILE: join(temporaryDirectory, 'semgrep.log'),
    SEMGREP_VERSION_CACHE_PATH: join(temporaryDirectory, 'semgrep-version-cache'),
  };
}
