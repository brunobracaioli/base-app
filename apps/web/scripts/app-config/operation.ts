import { APP_CONFIG_KEYS, appConfigValueSchemas } from '../../src/modules/app-config';
import { isAbsolute } from 'node:path';
import { parseJsonRejectDuplicateMembers } from './json';

export type AppConfigKey = (typeof APP_CONFIG_KEYS)[number];

export type CurrentSettingSnapshot = {
  readonly value: unknown | null;
  /** Preserve PostgreSQL's original text, including fractional-second precision, for CAS. */
  readonly updatedAt: string | null;
};

export type RollbackSource = {
  readonly eventId: string;
  readonly key: AppConfigKey;
  readonly before: unknown;
  readonly after: unknown;
};

export type ForceGuard = 'version_jump' | 'published_limit';

export type AppConfigOperationPlan = {
  readonly kind: 'set' | 'rollback';
  readonly key: AppConfigKey;
  readonly before: unknown | null;
  readonly after: unknown;
  readonly expectedUpdatedAt: string | null;
  readonly force: boolean;
  readonly forceReasons: readonly ForceGuard[];
  readonly diff: string;
  readonly rollbackEventId?: string;
};

export type AppConfigOperationErrorCode =
  | 'app_config.invalid_arguments'
  | 'app_config.invalid_json'
  | 'app_config.invalid_value'
  | 'app_config.invalid_current_value'
  | 'app_config.invalid_snapshot'
  | 'app_config.version_jump'
  | 'app_config.published_limit'
  | 'app_config.invalid_maintenance_until'
  | 'app_config.rollback_unavailable'
  | 'app_config.rollback_conflict'
  | 'app_config.read_failed';

const safeErrorMessages: Record<AppConfigOperationErrorCode, string> = {
  'app_config.invalid_arguments': 'Invalid app-config command arguments.',
  'app_config.invalid_json': 'The supplied app-config JSON is invalid.',
  'app_config.invalid_value': 'The app-config value does not match its schema.',
  'app_config.invalid_current_value': 'The stored app-config value is invalid.',
  'app_config.invalid_snapshot': 'The current app-config state is unavailable.',
  'app_config.version_jump':
    'minSupported exceeds the latest stored version; use --force only with approval.',
  'app_config.published_limit':
    'minSupported exceeds a version published to the store; use --force only with approval.',
  'app_config.invalid_maintenance_until': 'maintenance.until must be in the future.',
  'app_config.rollback_unavailable': 'No valid rollback source is available for this key.',
  'app_config.rollback_conflict': 'The rollback source no longer matches the current value.',
  'app_config.read_failed': 'The current app-config state could not be read.',
};

export class AppConfigOperationError extends Error {
  readonly code: AppConfigOperationErrorCode;

  constructor(code: AppConfigOperationErrorCode) {
    super(safeErrorMessages[code]);
    this.name = 'AppConfigOperationError';
    this.code = code;
  }
}

export type SetSource =
  | { readonly kind: 'json'; readonly value: string }
  | { readonly kind: 'file'; readonly path: string };

export type ParsedSetArguments = {
  readonly key: AppConfigKey;
  readonly source: SetSource;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly planPath?: string;
};

export type ParsedRollbackArguments = {
  readonly key: AppConfigKey;
  readonly dryRun: boolean;
  readonly planPath?: string;
};

function isAppConfigKey(value: string | undefined): value is AppConfigKey {
  return value !== undefined && (APP_CONFIG_KEYS as readonly string[]).includes(value);
}

function requiredOptionValue(args: readonly string[], index: number): string {
  const value = args[index + 1];
  if (
    value === undefined ||
    value.length === 0 ||
    (args[index] === '--file' && value.startsWith('--'))
  ) {
    throw new AppConfigOperationError('app_config.invalid_arguments');
  }
  return value;
}

export function parseSetArguments(args: readonly string[]): ParsedSetArguments {
  const keyArgument = args[0];
  if (!isAppConfigKey(keyArgument))
    throw new AppConfigOperationError('app_config.invalid_arguments');

  let source: SetSource | undefined;
  let dryRun = false;
  let force = false;
  let planPath: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json' || argument === '--file') {
      if (source !== undefined) throw new AppConfigOperationError('app_config.invalid_arguments');
      const value = requiredOptionValue(args, index);
      source = argument === '--json' ? { kind: 'json', value } : { kind: 'file', path: value };
      index += 1;
      continue;
    }
    if (argument === '--dry-run') {
      if (dryRun) throw new AppConfigOperationError('app_config.invalid_arguments');
      dryRun = true;
      continue;
    }
    if (argument === '--force') {
      if (force) throw new AppConfigOperationError('app_config.invalid_arguments');
      force = true;
      continue;
    }
    if (argument === '--plan') {
      if (planPath !== undefined) throw new AppConfigOperationError('app_config.invalid_arguments');
      const value = requiredOptionValue(args, index);
      if (!isAbsolute(value)) throw new AppConfigOperationError('app_config.invalid_arguments');
      planPath = value;
      index += 1;
      continue;
    }
    throw new AppConfigOperationError('app_config.invalid_arguments');
  }

  if (source === undefined) throw new AppConfigOperationError('app_config.invalid_arguments');
  if (dryRun && planPath !== undefined) {
    throw new AppConfigOperationError('app_config.invalid_arguments');
  }
  return {
    key: keyArgument,
    source,
    dryRun,
    force,
    ...(planPath === undefined ? {} : { planPath }),
  };
}

export function parseRollbackArguments(args: readonly string[]): ParsedRollbackArguments {
  const keyArgument = args[0];
  if (!isAppConfigKey(keyArgument))
    throw new AppConfigOperationError('app_config.invalid_arguments');
  if (args.length > 2 || (args.length === 2 && args[1] !== '--dry-run')) {
    const planIndex = args.indexOf('--plan');
    if (
      planIndex < 0 ||
      planIndex !== 1 ||
      args.length !== 3 ||
      args[2] === undefined ||
      !isAbsolute(args[2])
    ) {
      throw new AppConfigOperationError('app_config.invalid_arguments');
    }
    return { key: keyArgument, dryRun: false, planPath: args[2] };
  }
  return { key: keyArgument, dryRun: args[1] === '--dry-run' };
}

const MAX_CONFIG_JSON_BYTES = 2048;

export function parseJsonValue(raw: string): unknown {
  if (Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_JSON_BYTES) {
    throw new AppConfigOperationError('app_config.invalid_json');
  }
  try {
    return parseJsonRejectDuplicateMembers(raw);
  } catch {
    throw new AppConfigOperationError('app_config.invalid_json');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareNumericPart(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+/, '') || '0';
  const normalizedRight = right.replace(/^0+/, '') || '0';
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  }
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumericPart(leftParts[index] ?? '', rightParts[index] ?? '');
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`);
    return `{${entries.join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new AppConfigOperationError('app_config.invalid_value');
  return serialized;
}

function immutableJson(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableJson));
  if (isRecord(value)) {
    const copy = Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, immutableJson(nested)]),
    );
    return Object.freeze(copy);
  }
  return value;
}

function flattenValue(value: unknown, path: string, output: Map<string, string>): void {
  if (isRecord(value) && Object.keys(value).length > 0) {
    for (const key of Object.keys(value).sort()) {
      flattenValue(value[key], path.length > 0 ? `${path}.${key}` : key, output);
    }
    return;
  }
  output.set(path || '$', canonicalJson(value));
}

export function formatAppConfigDiff(
  key: AppConfigKey,
  before: unknown | null,
  after: unknown,
): string {
  const beforeValues = new Map<string, string>();
  const afterValues = new Map<string, string>();
  if (before !== null) flattenValue(before, '', beforeValues);
  flattenValue(after, '', afterValues);

  const paths = [...new Set([...beforeValues.keys(), ...afterValues.keys()])].sort();
  const changes = paths.flatMap((path) => {
    const previous = beforeValues.get(path);
    const next = afterValues.get(path);
    if (previous === next) return [];
    const lines: string[] = [];
    if (previous !== undefined) lines.push(`- ${key}.${path}: ${previous}`);
    if (next !== undefined) lines.push(`+ ${key}.${path}: ${next}`);
    return lines;
  });
  return changes.length > 0 ? changes.join('\n') : `${key}: no changes`;
}

function validateSnapshot(key: AppConfigKey, current: CurrentSettingSnapshot): unknown | null {
  if (current.value === null) {
    if (current.updatedAt !== null)
      throw new AppConfigOperationError('app_config.invalid_snapshot');
    return null;
  }
  if (typeof current.updatedAt !== 'string' || current.updatedAt.length === 0) {
    throw new AppConfigOperationError('app_config.invalid_snapshot');
  }
  const result = appConfigValueSchemas[key].safeParse(current.value);
  if (!result.success) throw new AppConfigOperationError('app_config.invalid_current_value');
  return current.value;
}

function validateProposedValue(key: AppConfigKey, proposedValue: unknown): unknown {
  const result = appConfigValueSchemas[key].safeParse(proposedValue);
  if (!result.success) throw new AppConfigOperationError('app_config.invalid_value');
  return result.data;
}

function preservePublishedVersions(before: unknown | null, after: unknown): unknown {
  if (before === null || !isRecord(before) || !isRecord(after)) return after;
  const beforeVersions = before;
  const proposedVersions = after;
  const merged: Record<string, unknown> = { ...proposedVersions };
  for (const platform of ['ios', 'android'] as const) {
    const previousPlatform = beforeVersions[platform];
    const proposedPlatform = proposedVersions[platform];
    if (!isRecord(previousPlatform) || !isRecord(proposedPlatform)) continue;
    if (proposedPlatform.published !== undefined || previousPlatform.published === undefined)
      continue;
    merged[platform] = { ...proposedPlatform, published: previousPlatform.published };
  }
  const result = appConfigValueSchemas.versions.safeParse(merged);
  if (!result.success) throw new AppConfigOperationError('app_config.invalid_value');
  return result.data;
}

function getVersionGuards(before: unknown | null, after: unknown): ForceGuard[] {
  if (before === null || !isRecord(before) || !isRecord(after)) return [];
  const reasons: ForceGuard[] = [];
  for (const platform of ['ios', 'android'] as const) {
    const previousPlatform = before[platform];
    const proposedPlatform = after[platform];
    if (!isRecord(previousPlatform) || !isRecord(proposedPlatform)) continue;
    const minSupported = proposedPlatform.minSupported;
    const previousLatest = previousPlatform.latest;
    const published = proposedPlatform.published;
    if (typeof minSupported !== 'string') continue;
    if (typeof previousLatest === 'string' && compareVersions(minSupported, previousLatest) > 0) {
      reasons.push('version_jump');
    }
    if (typeof published === 'string' && compareVersions(minSupported, published) > 0) {
      reasons.push('published_limit');
    }
  }
  return [...new Set(reasons)];
}

function validateCrossRules(key: AppConfigKey, after: unknown, now: Date): void {
  if (key !== 'maintenance' || !isRecord(after)) return;
  const until = after.until;
  if (until === null || until === undefined) return;
  const untilTimestamp = Date.parse(String(until));
  if (!Number.isFinite(untilTimestamp) || untilTimestamp <= now.getTime()) {
    throw new AppConfigOperationError('app_config.invalid_maintenance_until');
  }
}

function requireValidClock(now: Date): void {
  if (!Number.isFinite(now.getTime()))
    throw new AppConfigOperationError('app_config.invalid_snapshot');
}

export function planSetChange(input: {
  readonly key: AppConfigKey;
  readonly proposedValue: unknown;
  readonly current: CurrentSettingSnapshot;
  readonly force: boolean;
  readonly now: Date;
}): AppConfigOperationPlan {
  requireValidClock(input.now);
  const validatedBefore = validateSnapshot(input.key, input.current);
  const before = validatedBefore === null ? null : immutableJson(validatedBefore);
  const parsedProposal = validateProposedValue(input.key, input.proposedValue);
  const normalizedAfter =
    input.key === 'versions' ? preservePublishedVersions(before, parsedProposal) : parsedProposal;
  const after = immutableJson(normalizedAfter);
  validateCrossRules(input.key, after, input.now);

  const forceReasons = input.key === 'versions' ? getVersionGuards(before, after) : [];
  if (!input.force && forceReasons.includes('version_jump')) {
    throw new AppConfigOperationError('app_config.version_jump');
  }
  if (!input.force && forceReasons.includes('published_limit')) {
    throw new AppConfigOperationError('app_config.published_limit');
  }

  return Object.freeze({
    kind: 'set',
    key: input.key,
    before,
    after,
    expectedUpdatedAt: input.current.updatedAt,
    force: input.force,
    forceReasons: Object.freeze(forceReasons),
    diff: formatAppConfigDiff(input.key, before, after),
  });
}

export function planRollback(input: {
  readonly key: AppConfigKey;
  readonly current: CurrentSettingSnapshot;
  readonly source: RollbackSource | null;
}): AppConfigOperationPlan {
  const validatedBefore = validateSnapshot(input.key, input.current);
  if (validatedBefore === null || input.current.updatedAt === null || input.source === null) {
    throw new AppConfigOperationError('app_config.rollback_unavailable');
  }
  const before = immutableJson(validatedBefore);
  if (
    input.source.key !== input.key ||
    input.source.eventId.length === 0 ||
    canonicalJson(input.source.after) !== canonicalJson(before)
  ) {
    throw new AppConfigOperationError('app_config.rollback_conflict');
  }
  if (input.source.before === null)
    throw new AppConfigOperationError('app_config.rollback_unavailable');

  const after = immutableJson(validateProposedValue(input.key, input.source.before));
  return Object.freeze({
    kind: 'rollback',
    key: input.key,
    before,
    after,
    expectedUpdatedAt: input.current.updatedAt,
    force: false,
    forceReasons: Object.freeze([]),
    diff: formatAppConfigDiff(input.key, before, after),
    rollbackEventId: input.source.eventId,
  });
}

/**
 * Reader port only. A production writer adapter remains a separate approval decision.
 * Rollback sources must be key-scoped latest successful app_config.updated events.
 */
export interface AppConfigPlanningPort {
  readCurrent(key: AppConfigKey): Promise<CurrentSettingSnapshot>;
  readLatestRollbackSource(key: AppConfigKey): Promise<RollbackSource | null>;
}

export function createAppConfigPlanner(
  port: AppConfigPlanningPort,
  clock: () => Date = () => new Date(),
) {
  return Object.freeze({
    async planSet(input: {
      readonly key: AppConfigKey;
      readonly proposedValue: unknown;
      readonly force: boolean;
    }): Promise<AppConfigOperationPlan> {
      let current: CurrentSettingSnapshot;
      try {
        current = await port.readCurrent(input.key);
      } catch {
        throw new AppConfigOperationError('app_config.read_failed');
      }
      return planSetChange({ ...input, current, now: clock() });
    },
    async planRollback(key: AppConfigKey): Promise<AppConfigOperationPlan> {
      let current: CurrentSettingSnapshot;
      let source: RollbackSource | null;
      try {
        current = await port.readCurrent(key);
        source = await port.readLatestRollbackSource(key);
      } catch {
        throw new AppConfigOperationError('app_config.read_failed');
      }
      return planRollback({ key, current, source });
    },
  });
}

export type SafeOperationFailure = {
  readonly status: number;
  readonly code: string;
  readonly message: string;
};

/** Map known SQL conflicts without exposing driver messages, query text, or connection data. */
export function toSafeOperationFailure(error: unknown): SafeOperationFailure {
  if (error instanceof AppConfigOperationError) {
    const status = error.code === 'app_config.rollback_conflict' ? 409 : 400;
    return { status, code: error.code, message: safeErrorMessages[error.code] };
  }
  if (isRecord(error) && error.code === 'AC409') {
    return {
      status: 409,
      code: 'app_config.conflict',
      message: 'The app-config value changed; review the current diff before retrying.',
    };
  }
  return {
    status: 500,
    code: 'app_config.operation_failed',
    message: 'The app-config operation failed.',
  };
}
