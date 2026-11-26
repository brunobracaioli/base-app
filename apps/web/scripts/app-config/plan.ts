import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createApprovalEnvelope,
  getApprovalPayloadDigest,
  parseApprovalEnvelope,
  verifyApprovalSignatures,
  type ApprovalEnvelope,
  type ApprovalSignature,
  type TrustRegistry,
} from './approval';
import { AppConfigOperatorError, type AppConfigDatabaseTarget } from './environment';
import {
  AppConfigOperationError,
  formatAppConfigDiff,
  planRollback,
  planSetChange,
  type AppConfigKey,
  type AppConfigOperationPlan,
  type AppConfigPlanningPort,
  type CurrentSettingSnapshot,
  type RollbackSource,
} from './operation';

const MAX_PLAN_LIFETIME_MS = 60 * 60 * 1000;
export const DEFAULT_PLAN_LIFETIME_MS = 15 * 60 * 1000;
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const PayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  planId: z.string().uuid(),
  preparedAt: z.string().min(1).max(40),
  expiresAt: z.string().min(1).max(40),
  target: z.strictObject({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    database: z.string().min(1).max(128),
    username: z.string().min(1).max(128),
    caSha256: HashSchema,
  }),
  checkout: z.strictObject({
    commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  }),
  operation: z.strictObject({
    kind: z.enum(['set', 'rollback']),
    key: z.enum(['versions', 'maintenance', 'legal']),
    before: z.unknown(),
    after: z.unknown(),
    expectedUpdatedAt: z.string().max(80).nullable(),
    force: z.boolean(),
    forceReasons: z.array(z.enum(['version_jump', 'published_limit'])).max(2),
    diff: z.string().max(32_768),
    diffSha256: HashSchema,
    rollbackEventId: z.string().uuid().optional(),
  }),
});

export type AppConfigApprovalPayload = z.infer<typeof PayloadSchema>;
export type AppConfigApprovalEnvelope = ApprovalEnvelope<AppConfigApprovalPayload>;
export type CheckoutBinding = Readonly<{ commit: string; tree: string; clean: boolean }>;

export interface AppConfigMutationPort extends AppConfigPlanningPort {
  writeSetting(input: {
    readonly key: AppConfigKey;
    readonly value: unknown;
    readonly expectedUpdatedAt: string | null;
    readonly force: boolean;
    readonly actorRef: string;
    readonly correlationId: string;
  }): Promise<void>;
}

function fail(code: string, message: string): never {
  throw new AppConfigOperatorError(code, message);
}

function parsedDate(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    fail('app_config.plan_invalid', 'The app-config approval plan has an invalid time.');
  return parsed;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      fail('app_config.plan_invalid', 'The approval plan contains an unsupported value.');
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return fail('app_config.plan_invalid', 'The approval plan contains an unsupported value.');
}

function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameTarget(left: AppConfigDatabaseTarget, right: AppConfigDatabaseTarget): boolean {
  return (
    left.host === right.host &&
    left.port === right.port &&
    left.database === right.database &&
    left.username === right.username &&
    left.caSha256 === right.caSha256
  );
}

function validateOperationSemantics(
  operation: AppConfigApprovalPayload['operation'],
  validationTime: string,
): AppConfigOperationPlan {
  let derived: AppConfigOperationPlan;
  try {
    const current: CurrentSettingSnapshot = {
      value: operation.before,
      updatedAt: operation.expectedUpdatedAt,
    };
    if (operation.kind === 'set') {
      if (operation.rollbackEventId !== undefined) {
        fail('app_config.plan_invalid', 'A set plan cannot include a rollback source event.');
      }
      derived = planSetChange({
        key: operation.key,
        proposedValue: operation.after,
        current,
        force: operation.force,
        now: new Date(parsedDate(validationTime)),
      });
    } else {
      if (operation.force || operation.rollbackEventId === undefined) {
        fail(
          'app_config.plan_invalid',
          'A rollback plan must bind a source event and cannot force.',
        );
      }
      const source: RollbackSource = {
        eventId: operation.rollbackEventId,
        key: operation.key,
        before: operation.after,
        after: operation.before,
      };
      derived = planRollback({ key: operation.key, current, source });
    }
  } catch (error) {
    if (error instanceof AppConfigOperatorError) throw error;
    if (error instanceof AppConfigOperationError) {
      throw new AppConfigOperatorError('app_config.plan_invalid', error.message);
    }
    fail('app_config.plan_invalid', 'The app-config approval operation is invalid.');
  }

  const expected = {
    kind: derived.kind,
    key: derived.key,
    before: derived.before,
    after: derived.after,
    expectedUpdatedAt: derived.expectedUpdatedAt,
    force: derived.force,
    forceReasons: [...derived.forceReasons],
    diff: derived.diff,
    ...(derived.rollbackEventId === undefined ? {} : { rollbackEventId: derived.rollbackEventId }),
  };
  const received = {
    kind: operation.kind,
    key: operation.key,
    before: operation.before,
    after: operation.after,
    expectedUpdatedAt: operation.expectedUpdatedAt,
    force: operation.force,
    forceReasons: operation.forceReasons,
    diff: operation.diff,
    ...(operation.rollbackEventId === undefined
      ? {}
      : { rollbackEventId: operation.rollbackEventId }),
  };
  if (!sameJson(expected, received)) {
    fail('app_config.plan_invalid', 'The app-config diff and operation fields do not match.');
  }
  if (
    (operation.expectedUpdatedAt === null) !== (operation.before === null) ||
    (operation.expectedUpdatedAt !== null &&
      !Number.isFinite(Date.parse(operation.expectedUpdatedAt)))
  ) {
    fail('app_config.plan_invalid', 'The app-config CAS snapshot is invalid.');
  }
  return derived;
}

export function parseAppConfigApprovalPlan(value: unknown): AppConfigApprovalEnvelope {
  const parsedEnvelope = parseApprovalEnvelope(value);
  const parsedPayload = PayloadSchema.safeParse(parsedEnvelope.payload);
  if (!parsedPayload.success)
    fail('app_config.plan_invalid', 'The app-config plan format is invalid.');
  const payload = parsedPayload.data;
  const preparedAt = parsedDate(payload.preparedAt);
  const expiresAt = parsedDate(payload.expiresAt);
  if (expiresAt <= preparedAt || expiresAt - preparedAt > MAX_PLAN_LIFETIME_MS) {
    fail(
      'app_config.plan_invalid',
      'The app-config approval plan lifetime must be at most one hour.',
    );
  }
  if (payload.operation.diffSha256 !== digestText(payload.operation.diff)) {
    fail('app_config.plan_invalid', 'The app-config diff digest does not match.');
  }
  validateOperationSemantics(payload.operation, payload.preparedAt);
  if (getApprovalPayloadDigest(payload) !== parsedEnvelope.payloadSha256) {
    fail('app_config.plan_invalid', 'The app-config approval payload digest does not match.');
  }
  return {
    payload,
    payloadSha256: parsedEnvelope.payloadSha256,
    signatures: parsedEnvelope.signatures as readonly ApprovalSignature[],
  };
}

export function createAppConfigApprovalPlan(input: {
  readonly plan: AppConfigOperationPlan;
  readonly target: AppConfigDatabaseTarget;
  readonly checkout: Pick<CheckoutBinding, 'commit' | 'tree'>;
  readonly now: Date;
  readonly planId?: string;
  readonly expiresAt?: Date;
}): AppConfigApprovalEnvelope {
  if (!Number.isFinite(input.now.getTime()))
    fail('app_config.plan_invalid', 'The app-config clock is invalid.');
  const expiresAt = input.expiresAt ?? new Date(input.now.getTime() + DEFAULT_PLAN_LIFETIME_MS);
  if (
    expiresAt.getTime() <= input.now.getTime() ||
    expiresAt.getTime() - input.now.getTime() > MAX_PLAN_LIFETIME_MS
  ) {
    fail(
      'app_config.plan_invalid',
      'The app-config approval plan lifetime must be at most one hour.',
    );
  }
  const operation = {
    kind: input.plan.kind,
    key: input.plan.key,
    before: input.plan.before,
    after: input.plan.after,
    expectedUpdatedAt: input.plan.expectedUpdatedAt,
    force: input.plan.force,
    forceReasons: [...input.plan.forceReasons],
    diff: input.plan.diff,
    diffSha256: digestText(input.plan.diff),
    ...(input.plan.rollbackEventId === undefined
      ? {}
      : { rollbackEventId: input.plan.rollbackEventId }),
  } as const;
  const candidate: unknown = {
    schemaVersion: 1,
    planId: input.planId ?? randomUUID(),
    preparedAt: input.now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    target: input.target,
    checkout: {
      commit: input.checkout.commit,
      tree: input.checkout.tree,
    },
    operation,
  };
  const parsed = PayloadSchema.safeParse(candidate);
  if (!parsed.success)
    fail('app_config.plan_invalid', 'The app-config approval plan fields are invalid.');
  validateOperationSemantics(parsed.data.operation, parsed.data.preparedAt);
  const envelope = createApprovalEnvelope(parsed.data);
  return parseAppConfigApprovalPlan(envelope);
}

export function assertAppConfigApprovalContext(input: {
  readonly payload: AppConfigApprovalPayload;
  readonly target: AppConfigDatabaseTarget;
  readonly checkout: CheckoutBinding;
  readonly now: Date;
}): void {
  if (!Number.isFinite(input.now.getTime())) {
    fail('app_config.plan_invalid', 'The app-config approval clock is invalid.');
  }
  if (!input.checkout.clean)
    fail('app_config.checkout_dirty', 'The checkout must be clean to sign or execute a plan.');
  if (
    input.payload.checkout.commit !== input.checkout.commit ||
    input.payload.checkout.tree !== input.checkout.tree
  ) {
    fail('app_config.checkout_changed', 'The plan is bound to a different clean commit and tree.');
  }
  if (!sameTarget(input.payload.target, input.target)) {
    fail(
      'app_config.destination_changed',
      'The plan is bound to a different admin database destination.',
    );
  }
  if (parsedDate(input.payload.preparedAt) > input.now.getTime()) {
    fail('app_config.plan_from_future', 'The app-config approval plan was prepared in the future.');
  }
  if (input.now.getTime() >= parsedDate(input.payload.expiresAt)) {
    fail('app_config.plan_expired', 'The app-config approval plan has expired.');
  }
}

function snapshotMatches(
  payload: AppConfigApprovalPayload,
  current: CurrentSettingSnapshot,
): boolean {
  return (
    current.updatedAt === payload.operation.expectedUpdatedAt &&
    sameJson(current.value, payload.operation.before)
  );
}

export async function executeApprovedAppConfigPlan(input: {
  readonly envelope: unknown;
  readonly trustRegistry: TrustRegistry;
  readonly port: AppConfigMutationPort;
  readonly target: AppConfigDatabaseTarget;
  readonly checkout: CheckoutBinding;
  readonly now: Date;
  readonly clock?: () => Date;
  readonly refreshContext?: () => {
    readonly target: AppConfigDatabaseTarget;
    readonly checkout: CheckoutBinding;
  };
}): Promise<{ readonly planId: string; readonly payloadSha256: string }> {
  const { trustRegistry, port, now } = input;
  const envelope = parseAppConfigApprovalPlan(input.envelope);
  try {
    verifyApprovalSignatures(envelope, trustRegistry, true);
  } catch {
    fail('app_config.approval_required', 'Two distinct trusted identities must sign the plan.');
  }
  assertAppConfigApprovalContext({
    payload: envelope.payload,
    target: input.target,
    checkout: {
      commit: input.checkout.commit,
      tree: input.checkout.tree,
      clean: input.checkout.clean,
    },
    now,
  });
  if (now.getTime() >= parsedDate(envelope.payload.expiresAt)) {
    fail('app_config.plan_expired', 'The app-config approval plan has expired.');
  }
  const currentPayloadOperation = envelope.payload.operation;
  validateOperationSemantics(currentPayloadOperation, now.toISOString());

  let current: CurrentSettingSnapshot;
  try {
    current = await port.readCurrent(currentPayloadOperation.key);
  } catch {
    fail('app_config.read_failed', 'The current app-config state could not be read.');
  }
  if (!snapshotMatches(envelope.payload, current)) {
    fail(
      'app_config.conflict',
      'The app-config value changed; prepare a fresh plan before retrying.',
    );
  }

  if (currentPayloadOperation.kind === 'rollback') {
    let source: RollbackSource | null;
    try {
      source = await port.readLatestRollbackSource(currentPayloadOperation.key);
    } catch {
      fail('app_config.read_failed', 'The current app-config state could not be read.');
    }
    if (
      source === null ||
      source.eventId !== currentPayloadOperation.rollbackEventId ||
      source.key !== currentPayloadOperation.key ||
      !sameJson(source.before, currentPayloadOperation.after) ||
      !sameJson(source.after, currentPayloadOperation.before)
    ) {
      fail('app_config.rollback_conflict', 'The rollback source changed; prepare a fresh plan.');
    }
  }

  const mutationNow = input.clock?.() ?? now;
  const mutationContext = input.refreshContext?.() ?? {
    target: input.target,
    checkout: input.checkout,
  };
  assertAppConfigApprovalContext({
    payload: envelope.payload,
    target: mutationContext.target,
    checkout: mutationContext.checkout,
    now: mutationNow,
  });
  validateOperationSemantics(currentPayloadOperation, mutationNow.toISOString());

  const payloadSha256 = getApprovalPayloadDigest(envelope.payload);
  try {
    await port.writeSetting({
      key: currentPayloadOperation.key,
      value: currentPayloadOperation.after,
      expectedUpdatedAt: currentPayloadOperation.expectedUpdatedAt,
      force: currentPayloadOperation.force,
      actorRef: `script:app-config:${envelope.payload.planId}`,
      correlationId: payloadSha256,
    });
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (code === 'AC409') {
      fail(
        'app_config.conflict',
        'The app-config value changed; prepare a fresh plan before retrying.',
      );
    }
    fail(
      'app_config.operation_failed',
      'The app-config operation failed; reconcile this plan before retrying.',
    );
  }
  return Object.freeze({ planId: envelope.payload.planId, payloadSha256 });
}

export function approvalEnvelopeToJson(envelope: unknown): string {
  return `${JSON.stringify(parseAppConfigApprovalPlan(envelope), null, 2)}\n`;
}

export function trustRegistryHasTwoKeys(trustRegistry: TrustRegistry): boolean {
  return new Set([...trustRegistry.values()].map((entry) => entry.fingerprintSha256)).size >= 2;
}

export function appConfigOperationFromPlan(
  envelope: AppConfigApprovalEnvelope,
): AppConfigOperationPlan {
  const operation = envelope.payload.operation;
  return Object.freeze({
    kind: operation.kind,
    key: operation.key,
    before: operation.before,
    after: operation.after,
    expectedUpdatedAt: operation.expectedUpdatedAt,
    force: operation.force,
    forceReasons: Object.freeze([...operation.forceReasons]),
    diff: formatAppConfigDiff(operation.key, operation.before, operation.after),
    ...(operation.rollbackEventId === undefined
      ? {}
      : { rollbackEventId: operation.rollbackEventId }),
  });
}

export function assertPlanDiffMatches(envelope: AppConfigApprovalEnvelope): void {
  const operation = envelope.payload.operation;
  if (operation.diff !== formatAppConfigDiff(operation.key, operation.before, operation.after)) {
    fail('app_config.plan_invalid', 'The signed app-config diff does not match its values.');
  }
}

export function getPlanSignatures(
  envelope: AppConfigApprovalEnvelope,
): readonly ApprovalSignature[] {
  return envelope.signatures;
}
