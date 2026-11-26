import { execFileSync } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseApprovalEnvelope,
  parseTrustRegistry,
  signApprovalEnvelope,
  verifyApprovalSignatures,
} from './approval';
import { adaptPgPool, createAppConfigAdminPool, createPostgresAppConfigAdapter } from './database';
import {
  AppConfigOperatorError,
  defaultPlanDirectory,
  loadAppConfigOperatorEnvironment,
  loadAppConfigSigningEnvironment,
} from './environment';
import {
  createPrivatePlanDirectory,
  readPrivateJsonFile,
  readProtectedFile,
  rewritePrivateFile,
  writeNewPrivateFile,
} from './files';
import { parseJsonRejectDuplicateMembers } from './json';
import {
  AppConfigOperationError,
  createAppConfigPlanner,
  parseJsonValue,
  parseRollbackArguments,
  parseSetArguments,
  type AppConfigOperationPlan,
} from './operation';
import {
  approvalEnvelopeToJson,
  assertAppConfigApprovalContext,
  createAppConfigApprovalPlan,
  executeApprovedAppConfigPlan,
  parseAppConfigApprovalPlan,
  trustRegistryHasTwoKeys,
} from './plan';

const checkoutRootPromise = realpath(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'),
);
const MAX_CONFIG_FILE_BYTES = 2048;
const MAX_SIGNING_KEY_BYTES = 16 * 1024;
const MAX_TRUST_FILE_BYTES = 64 * 1024;

type GitCheckoutState = Readonly<{ commit: string; tree: string; clean: boolean }>;

function writeJson(stream: NodeJS.WriteStream, record: Readonly<Record<string, unknown>>): void {
  stream.write(`${JSON.stringify(record)}\n`);
}

function gitOutput(root: string, args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new AppConfigOperatorError(
      'app_config.checkout_unavailable',
      'The current Git checkout could not be verified.',
    );
  }
}

function captureCheckout(root: string, requireClean: boolean): GitCheckoutState {
  const status = gitOutput(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const commit = gitOutput(root, ['rev-parse', '--verify', 'HEAD']);
  const tree = gitOutput(root, ['rev-parse', '--verify', 'HEAD^{tree}']);
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)
  ) {
    throw new AppConfigOperatorError(
      'app_config.checkout_unavailable',
      'The current Git checkout could not be verified.',
    );
  }
  const clean = status.length === 0;
  if (requireClean && !clean) {
    throw new AppConfigOperatorError(
      'app_config.checkout_dirty',
      'The checkout must be clean before signing or executing a plan.',
    );
  }
  return Object.freeze({ commit, tree, clean });
}

function sameCheckout(left: GitCheckoutState, right: GitCheckoutState): boolean {
  return left.clean && right.clean && left.commit === right.commit && left.tree === right.tree;
}

async function loadTrustRegistry(path: string, checkoutRoot: string) {
  return readPrivateJsonFile(path, checkoutRoot, MAX_TRUST_FILE_BYTES, parseTrustRegistry);
}

async function readConfigFile(path: string): Promise<unknown> {
  const absolutePath = resolve(process.cwd(), path);
  let metadata;
  try {
    metadata = await lstat(absolutePath);
  } catch {
    throw new AppConfigOperatorError(
      'app_config.invalid_json',
      'The app-config JSON file is unavailable.',
    );
  }
  if (!metadata.isFile() || metadata.size > MAX_CONFIG_FILE_BYTES) {
    throw new AppConfigOperatorError(
      'app_config.invalid_json',
      'The app-config JSON file must be a file of at most 2048 bytes.',
    );
  }
  try {
    const source = await readFile(absolutePath, 'utf8');
    return parseJsonValue(source);
  } catch (error) {
    if (error instanceof AppConfigOperationError || error instanceof AppConfigOperatorError)
      throw error;
    throw new AppConfigOperatorError(
      'app_config.invalid_json',
      'The app-config JSON file is invalid.',
    );
  }
}

function planToResult(plan: AppConfigOperationPlan): Readonly<Record<string, unknown>> {
  return {
    kind: plan.kind,
    key: plan.key,
    before: plan.before,
    after: plan.after,
    expectedUpdatedAt: plan.expectedUpdatedAt,
    force: plan.force,
    forceReasons: plan.forceReasons,
    diff: plan.diff,
    ...(plan.rollbackEventId === undefined ? {} : { rollbackEventId: plan.rollbackEventId }),
  };
}

async function withDatabase<T>(
  environment: ReturnType<typeof loadAppConfigOperatorEnvironment>,
  operation: (adapter: ReturnType<typeof createPostgresAppConfigAdapter>) => Promise<T>,
): Promise<T> {
  const pool = createAppConfigAdminPool(environment);
  const adapter = createPostgresAppConfigAdapter(adaptPgPool(pool), environment.database.user);
  try {
    return await operation(adapter);
  } finally {
    try {
      await pool.end();
    } catch {
      // Do not expose driver details after a completed or uncertain operation.
    }
  }
}

function parsePlanPathArguments(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== '--plan' || args[1] === undefined) {
    throw new AppConfigOperationError('app_config.invalid_arguments');
  }
  return args[1];
}

function parseSignArguments(args: readonly string[]): {
  readonly planPath: string;
  readonly approvalDigest?: string;
} {
  let planPath: string | undefined;
  let approvalDigest: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.length === 0) {
      throw new AppConfigOperationError('app_config.invalid_arguments');
    }
    if (flag === '--plan' && planPath === undefined) {
      planPath = value;
    } else if (flag === '--approve-sha256' && approvalDigest === undefined) {
      approvalDigest = value;
    } else {
      throw new AppConfigOperationError('app_config.invalid_arguments');
    }
    index += 1;
  }
  if (
    planPath === undefined ||
    (approvalDigest !== undefined && !/^[a-f0-9]{64}$/.test(approvalDigest))
  ) {
    throw new AppConfigOperationError('app_config.invalid_arguments');
  }
  return { planPath, approvalDigest };
}

function requireDigestApproval(expected: string, supplied: string | undefined): void {
  if (supplied === undefined || !/^[a-f0-9]{64}$/.test(supplied)) {
    throw new AppConfigOperatorError(
      'app_config.signature_confirmation_required',
      'Review the signature preview, then pass its exact digest with --approve-sha256.',
    );
  }
  const expectedBytes = Buffer.from(expected, 'hex');
  const suppliedBytes = Buffer.from(supplied, 'hex');
  if (!timingSafeEqual(expectedBytes, suppliedBytes)) {
    throw new AppConfigOperatorError(
      'app_config.signature_confirmation_mismatch',
      'The supplied approval digest does not match the reviewed plan.',
    );
  }
}

export async function signAfterDigestApproval<T>(
  expectedDigest: string,
  suppliedDigest: string | undefined,
  sign: () => T | Promise<T>,
): Promise<T> {
  requireDigestApproval(expectedDigest, suppliedDigest);
  return await sign();
}

async function readApprovalPlan(path: string, checkoutRoot: string) {
  const bytes = await readProtectedFile(path, checkoutRoot, 128 * 1024);
  let raw: unknown;
  try {
    raw = parseJsonRejectDuplicateMembers(bytes.toString('utf8'));
  } catch {
    throw new AppConfigOperatorError(
      'app_config.plan_invalid',
      'The app-config approval plan format is invalid.',
    );
  }
  return parseAppConfigApprovalPlan(parseApprovalEnvelope(raw));
}

async function writePreparedPlan(
  plan: AppConfigOperationPlan,
  environment: ReturnType<typeof loadAppConfigOperatorEnvironment>,
  checkout: GitCheckoutState,
  checkoutRoot: string,
  requestedPath: string | undefined,
  now: Date,
): Promise<{
  readonly path: string;
  readonly planId: string;
  readonly envelope: ReturnType<typeof createAppConfigApprovalPlan>;
}> {
  const planId = randomUUID();
  const envelope = createAppConfigApprovalPlan({
    plan,
    target: environment.target,
    checkout,
    now,
    planId,
  });
  let path: string;
  if (requestedPath !== undefined) {
    path = requestedPath;
  } else {
    const directory = await createPrivatePlanDirectory(
      defaultPlanDirectory(process.env),
      checkoutRoot,
    );
    path = resolve(directory, `${planId}.json`);
  }
  await writeNewPrivateFile(path, checkoutRoot, approvalEnvelopeToJson(envelope));
  return { path, planId, envelope };
}

async function runSet(args: readonly string[], checkoutRoot: string): Promise<void> {
  const parsed = parseSetArguments(args);
  const environment = loadAppConfigOperatorEnvironment(process.env, checkoutRoot);
  const trustRegistry = await loadTrustRegistry(environment.trustFile, checkoutRoot);
  if (!trustRegistryHasTwoKeys(trustRegistry)) {
    throw new AppConfigOperatorError(
      'app_config.trust_invalid',
      'At least two distinct trusted identities are required.',
    );
  }
  const proposedValue =
    parsed.source.kind === 'json'
      ? parseJsonValue(parsed.source.value)
      : await readConfigFile(parsed.source.path);

  const checkoutBefore = parsed.dryRun ? undefined : captureCheckout(checkoutRoot, true);
  const result = await withDatabase(environment, async (adapter) => {
    const planner = createAppConfigPlanner(adapter);
    return planner.planSet({ key: parsed.key, proposedValue, force: parsed.force });
  });
  if (parsed.dryRun) {
    writeJson(process.stdout, {
      event: 'app_config.dry_run',
      operation: planToResult(result),
    });
    return;
  }
  const checkoutAfter = captureCheckout(checkoutRoot, true);
  if (checkoutBefore === undefined || !sameCheckout(checkoutBefore, checkoutAfter)) {
    throw new AppConfigOperatorError(
      'app_config.checkout_changed',
      'The checkout changed while preparing the plan.',
    );
  }
  const prepared = await writePreparedPlan(
    result,
    environment,
    checkoutAfter,
    checkoutRoot,
    parsed.planPath,
    new Date(),
  );
  writeJson(process.stdout, {
    event: 'app_config.plan_prepared',
    plan_id: prepared.planId,
    plan_sha256: prepared.envelope.payloadSha256,
    expires_at: prepared.envelope.payload.expiresAt,
    plan_file: prepared.path,
    operation: planToResult(result),
  });
}

async function runRollback(args: readonly string[], checkoutRoot: string): Promise<void> {
  const parsed = parseRollbackArguments(args);
  const environment = loadAppConfigOperatorEnvironment(process.env, checkoutRoot);
  const trustRegistry = await loadTrustRegistry(environment.trustFile, checkoutRoot);
  if (!trustRegistryHasTwoKeys(trustRegistry)) {
    throw new AppConfigOperatorError(
      'app_config.trust_invalid',
      'At least two distinct trusted identities are required.',
    );
  }
  const checkoutBefore = parsed.dryRun ? undefined : captureCheckout(checkoutRoot, true);
  const result = await withDatabase(environment, async (adapter) => {
    const planner = createAppConfigPlanner(adapter);
    return planner.planRollback(parsed.key);
  });
  if (parsed.dryRun) {
    writeJson(process.stdout, {
      event: 'app_config.dry_run',
      operation: planToResult(result),
    });
    return;
  }
  const checkoutAfter = captureCheckout(checkoutRoot, true);
  if (checkoutBefore === undefined || !sameCheckout(checkoutBefore, checkoutAfter)) {
    throw new AppConfigOperatorError(
      'app_config.checkout_changed',
      'The checkout changed while preparing the plan.',
    );
  }
  const prepared = await writePreparedPlan(
    result,
    environment,
    checkoutAfter,
    checkoutRoot,
    parsed.planPath,
    new Date(),
  );
  writeJson(process.stdout, {
    event: 'app_config.plan_prepared',
    plan_id: prepared.planId,
    plan_sha256: prepared.envelope.payloadSha256,
    expires_at: prepared.envelope.payload.expiresAt,
    plan_file: prepared.path,
    operation: planToResult(result),
  });
}

async function runSign(args: readonly string[], checkoutRoot: string): Promise<void> {
  const signArguments = parseSignArguments(args);
  const planPath = signArguments.planPath;
  const environment = loadAppConfigSigningEnvironment(process.env, checkoutRoot);
  const trustRegistry = await loadTrustRegistry(environment.trustFile, checkoutRoot);
  const envelope = await readApprovalPlan(planPath, checkoutRoot);
  const now = new Date();
  const checkout = captureCheckout(checkoutRoot, true);
  assertAppConfigApprovalContext({
    payload: envelope.payload,
    target: envelope.payload.target,
    checkout,
    now,
  });
  verifyApprovalSignatures(envelope, trustRegistry, false);
  writeJson(process.stdout, {
    event: 'app_config.signature_review',
    plan_id: envelope.payload.planId,
    plan_sha256: envelope.payloadSha256,
    expires_at: envelope.payload.expiresAt,
    target: envelope.payload.target,
    checkout: envelope.payload.checkout,
    operation: envelope.payload.operation,
  });
  const signed = await signAfterDigestApproval(
    envelope.payloadSha256,
    signArguments.approvalDigest,
    async () => {
      const keyBytes = await readProtectedFile(
        environment.signingKeyFile,
        checkoutRoot,
        MAX_SIGNING_KEY_BYTES,
      );
      const signingTime = new Date();
      const signingCheckout = captureCheckout(checkoutRoot, true);
      assertAppConfigApprovalContext({
        payload: envelope.payload,
        target: envelope.payload.target,
        checkout: signingCheckout,
        now: signingTime,
      });
      return signApprovalEnvelope(envelope, keyBytes.toString('utf8'), trustRegistry);
    },
  );
  const signedEnvelope = parseAppConfigApprovalPlan(signed);
  await rewritePrivateFile(planPath, checkoutRoot, approvalEnvelopeToJson(signedEnvelope));
  const mostRecent = signedEnvelope.signatures[signedEnvelope.signatures.length - 1];
  writeJson(process.stdout, {
    event: 'app_config.plan_signed',
    plan_id: signedEnvelope.payload.planId,
    signer: mostRecent?.identity,
    signature_count: signedEnvelope.signatures.length,
    plan_sha256: signedEnvelope.payloadSha256,
  });
}

async function runExecute(args: readonly string[], checkoutRoot: string): Promise<void> {
  const planPath = parsePlanPathArguments(args);
  const environment = loadAppConfigOperatorEnvironment(process.env, checkoutRoot);
  const trustRegistry = await loadTrustRegistry(environment.trustFile, checkoutRoot);
  const envelope = await readApprovalPlan(planPath, checkoutRoot);
  const now = new Date();
  const checkout = captureCheckout(checkoutRoot, true);
  assertAppConfigApprovalContext({
    payload: envelope.payload,
    target: environment.target,
    checkout,
    now,
  });
  verifyApprovalSignatures(envelope, trustRegistry, true);
  const receipt = await withDatabase(environment, (adapter) =>
    executeApprovedAppConfigPlan({
      envelope,
      trustRegistry,
      port: adapter,
      target: environment.target,
      checkout,
      now,
      clock: () => new Date(),
      refreshContext: () => ({
        target: environment.target,
        checkout: captureCheckout(checkoutRoot, true),
      }),
    }),
  );
  writeJson(process.stdout, {
    event: 'app_config.operation_succeeded',
    plan_id: receipt.planId,
    correlation_id: receipt.payloadSha256,
  });
}

export async function runAppConfigCli(argv: readonly string[]): Promise<number> {
  try {
    const checkoutRoot = await checkoutRootPromise;
    const [command, ...args] = argv;
    switch (command) {
      case 'set':
        await runSet(args, checkoutRoot);
        return 0;
      case 'rollback':
        await runRollback(args, checkoutRoot);
        return 0;
      case 'sign':
        await runSign(args, checkoutRoot);
        return 0;
      case 'execute':
        await runExecute(args, checkoutRoot);
        return 0;
      default:
        throw new AppConfigOperationError('app_config.invalid_arguments');
    }
  } catch (error) {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'app_config.operation_failed';
    const message =
      error instanceof AppConfigOperatorError || error instanceof AppConfigOperationError
        ? error.message
        : code === 'app_config.conflict'
          ? 'The app-config value changed; prepare a fresh plan.'
          : 'The app-config operation failed. No database details were exposed.';
    writeJson(process.stderr, { event: 'app_config.operation_failed', code, message });
    return 1;
  }
}

const invocationPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
const modulePath = resolve(fileURLToPath(import.meta.url));
if (invocationPath === modulePath) {
  process.exitCode = await runAppConfigCli(process.argv.slice(2));
}
