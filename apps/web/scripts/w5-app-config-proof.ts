import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { Pool, TypeOverrides, types } from 'pg';
import type { PoolClient, PoolConfig } from 'pg';

import { coreEndpoints } from '@base-app/contracts';
import { APP_CONFIG_KEYS, appConfigValueSchemas } from '../src/modules/app-config';
import { createCoreComposition } from '../src/platform/composition/core';
import { createDatabase } from '../src/platform/db';
import { createDefaultRouteDependencies } from '../src/platform/http/runtime';
import { createDefineRoute } from '../src/platform/http/define-route';
import { createCoreRouteDefinitions } from '../src/platform/http/core-routes';
import { createUuidV7 } from '../src/platform/http/request-id';
import type { RouteDependencies } from '../src/platform/http/types';
import type { RateLimiter, RateLimitResult } from '../src/platform/http/rate-limit';
import { serverExtensionComposition } from '../src/platform/composition';
import type { AppLogger } from '../src/platform/observability/logger';

const RUNTIME_INPUT_PATH = '/tmp/app-base-w5-runtime-secrets/database-inputs.json';
const ADMIN_INPUT_PATH = '/tmp/app-base-w5-runtime-secrets/admin-inputs.json';
const EXPECTED_HOST = '127.0.0.1';
const EXPECTED_PORT = '55452';
const EXPECTED_DATABASE = '/postgres';
const MAX_WRITE_ATTEMPTS = 12;
const RESULT_MARKER = 'W5_APP_CONFIG_PROOF_RESULT=';
const SETTING_KEYS = ['versions', 'maintenance', 'legal'] as const;

type SettingKey = (typeof SETTING_KEYS)[number];
type DatabaseEnvironment = {
  readonly DATABASE_URL: string;
  readonly DATABASE_CA_CERT: string;
};
type DatabaseInput = DatabaseEnvironment & { readonly role: 'api_runtime' | 'supabase_admin' };
type SettingRow = { readonly value: unknown; readonly updatedAt: string };
type SafeCheck = {
  readonly name: string;
  readonly passed: boolean;
  readonly status?: number | undefined;
  readonly code?: string | undefined;
  readonly retryAfter?: string | undefined;
};
type SafeResult = {
  readonly passed: boolean;
  readonly target: '127.0.0.1:55452/postgres';
  readonly runtimeRole: 'api_runtime';
  readonly writerRole: 'app_config_writer';
  readonly writeAttempts: number;
  readonly checks: readonly SafeCheck[];
  readonly failedCheck?: string;
};
type CapturedLog = {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
};

class ProofFailure extends Error {
  constructor(readonly checkName: string) {
    super('W5 app-config proof failed.');
    this.name = 'ProofFailure';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new ProofFailure('input.shape');
  return value;
}

function parseDatabaseInput(path: string, expectedRole: DatabaseInput['role']): DatabaseInput {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new ProofFailure('input.permissions');

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ProofFailure('input.shape');
  }
  if (
    !isRecord(parsed) ||
    !sameStringSet(Object.keys(parsed), ['DATABASE_URL', 'DATABASE_CA_CERT'])
  ) {
    throw new ProofFailure('input.shape');
  }

  const database: DatabaseEnvironment = {
    DATABASE_URL: requireString(parsed.DATABASE_URL),
    DATABASE_CA_CERT: requireString(parsed.DATABASE_CA_CERT),
  };
  const url = new URL(database.DATABASE_URL);
  let role: string;
  try {
    role = decodeURIComponent(url.username);
  } catch {
    throw new ProofFailure('input.target');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== EXPECTED_HOST ||
    url.port !== EXPECTED_PORT ||
    url.pathname !== EXPECTED_DATABASE ||
    role !== expectedRole ||
    url.search !== '' ||
    url.hash !== '' ||
    database.DATABASE_CA_CERT.trim().length === 0
  ) {
    throw new ProofFailure('input.target');
  }
  return { ...database, role: expectedRole };
}

function addCheck(
  checks: SafeCheck[],
  name: string,
  passed: boolean,
  fields: Omit<SafeCheck, 'name' | 'passed'> = {},
): void {
  checks.push({ name, passed, ...fields });
  if (!passed) throw new ProofFailure(name);
}

function recordFailure(checks: SafeCheck[], name: string): void {
  if (!checks.some((check) => check.name === name && !check.passed)) {
    checks.push({ name, passed: false });
  }
}

function createAdminPool(input: DatabaseInput): Pool {
  const timestampTypes = new TypeOverrides();
  timestampTypes.setTypeParser(types.builtins.TIMESTAMP, (value: string) => value);
  timestampTypes.setTypeParser(types.builtins.TIMESTAMPTZ, (value: string) => value);

  const config: PoolConfig = {
    connectionString: input.DATABASE_URL,
    ssl: { ca: input.DATABASE_CA_CERT, rejectUnauthorized: true },
    max: 1,
    connectionTimeoutMillis: 3_000,
    query_timeout: 20_000,
    statement_timeout: 20_000,
    idle_in_transaction_session_timeout: 20_000,
    lock_timeout: 3_000,
    types: timestampTypes,
  };
  return new Pool(config);
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

async function readSetting(pool: Pool, key: SettingKey): Promise<SettingRow> {
  const result = await pool.query<{ value: unknown; updated_at: string }>(
    'select value, updated_at from app_config.settings where key = $1',
    [key],
  );
  if (result.rowCount !== 1 || typeof result.rows[0]?.updated_at !== 'string') {
    throw new ProofFailure('db.snapshot');
  }
  return { value: result.rows[0].value, updatedAt: result.rows[0].updated_at };
}

async function readAllSettings(pool: Pool): Promise<Record<SettingKey, SettingRow>> {
  const result = await pool.query<{ key: string; value: unknown; updated_at: string }>(
    'select key, value, updated_at from app_config.settings where key = any($1::text[])',
    [[...SETTING_KEYS]],
  );
  const values = new Map<string, SettingRow>();
  for (const row of result.rows) {
    if (SETTING_KEYS.includes(row.key as SettingKey) && typeof row.updated_at === 'string') {
      values.set(row.key, { value: row.value, updatedAt: row.updated_at });
    }
  }
  if (values.size !== SETTING_KEYS.length) throw new ProofFailure('db.snapshot');
  return {
    versions: values.get('versions') as SettingRow,
    maintenance: values.get('maintenance') as SettingRow,
    legal: values.get('legal') as SettingRow,
  };
}

function sqlLiterals(value: string): readonly string[] {
  return [...value.matchAll(/'((?:[^']|'')*)'/g)].map((match) =>
    (match[1] ?? '').replaceAll("''", "'"),
  );
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((item) => rightSet.has(item))
  );
}

async function readDatabaseKeyAllowLists(pool: Pool): Promise<{
  readonly tableConstraintKeys: readonly string[];
  readonly functionGuardKeys: readonly string[];
}> {
  const constraints = await pool.query<{ definition: string }>(
    `select pg_get_constraintdef(constraint_row.oid) as definition
       from pg_catalog.pg_constraint as constraint_row
      where constraint_row.conrelid = 'app_config.settings'::regclass
        and constraint_row.contype = 'c'`,
  );
  const keyConstraintRows = constraints.rows.filter((row) =>
    /\bkey\s*=\s*any\s*\(\s*array\s*\[/i.test(row.definition),
  );
  if (keyConstraintRows.length !== 1 || typeof keyConstraintRows[0]?.definition !== 'string') {
    throw new ProofFailure('db.table_key_constraint_catalog');
  }

  const functionResult = await pool.query<{ definition: string | null }>(
    `select pg_catalog.pg_get_functiondef(
       pg_catalog.to_regprocedure($1)::oid
     ) as definition`,
    ['app_config.set_setting(text,jsonb,text,text,text,timestamptz,boolean)'],
  );
  const functionDefinition = functionResult.rows[0]?.definition;
  if (typeof functionDefinition !== 'string') throw new ProofFailure('db.set_setting_catalog');

  const guard = functionDefinition.match(/\bp_key\s+not\s+in\s*\(([^()]*)\)/i);
  if (!guard?.[1]) throw new ProofFailure('db.set_setting_key_guard_catalog');
  return {
    tableConstraintKeys: sqlLiterals(keyConstraintRows[0].definition),
    functionGuardKeys: sqlLiterals(guard[1]),
  };
}

async function writeSetting(
  pool: Pool,
  key: SettingKey,
  value: unknown,
  expectedUpdatedAt: string,
  actorRef: string,
): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('begin isolation level read committed');
    await client.query('set local role app_config_writer');
    await client.query(
      `select app_config.set_setting(
        $1::text, $2::jsonb, 'system'::text, $3::text, $4::text, $5::timestamptz
      )`,
      [key, JSON.stringify(value), actorRef, actorRef, expectedUpdatedAt],
    );
    await client.query('commit');
  } catch {
    try {
      await client.query('rollback');
    } catch {
      // The original safe failure name is reported; driver details stay private.
    }
    throw new ProofFailure('db.setting_write');
  } finally {
    client.release();
  }
}

function versions(minimum: string, latest: string) {
  return {
    ios: { minSupported: minimum, latest },
    android: { minSupported: minimum, latest },
  };
}

function maintenance(active: boolean, platforms: readonly ('ios' | 'android')[]) {
  return { active, platforms: [...platforms], messageKey: 'maintenance.default', until: null };
}

function request(path: string, method = 'GET', headers: Record<string, string> = {}): Request {
  return new Request(`https://app.example.invalid${path}`, {
    method,
    headers: { 'x-real-ip': '198.51.100.12', ...headers },
  });
}

async function jsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseCode(body: unknown): string | undefined {
  return isRecord(body) && typeof body.code === 'string' ? body.code : undefined;
}

function createHarnessLogger(logs: CapturedLog[]): AppLogger {
  return Object.freeze({
    info(message: string, fields: Readonly<Record<string, unknown>>) {
      logs.push({ level: 'info', message, fields });
    },
    warn(message: string, fields: Readonly<Record<string, unknown>>) {
      logs.push({ level: 'warn', message, fields });
    },
    error(message: string, fields: Readonly<Record<string, unknown>>) {
      logs.push({ level: 'error', message, fields });
    },
  });
}

function createHarnessRateLimiter(): RateLimiter {
  return Object.freeze({
    async consume(input: Parameters<RateLimiter['consume']>[0]): Promise<RateLimitResult> {
      return {
        allowed: true,
        limit: input.limit,
        remaining: Math.max(0, input.limit - 1),
        resetAtMs: input.nowMs + input.windowSec * 1_000,
      };
    },
  });
}

function isNoPublishedField(body: unknown): boolean {
  if (!isRecord(body) || !isRecord(body.versions)) return false;
  for (const platform of ['ios', 'android'] as const) {
    const value = body.versions[platform];
    if (!isRecord(value) || Object.hasOwn(value, 'published')) return false;
  }
  return true;
}

async function runProof(): Promise<SafeResult> {
  const checks: SafeCheck[] = [];
  const logs: CapturedLog[] = [];
  let snapshots: Record<SettingKey, SettingRow> | undefined;
  let adminPool: Pool | undefined;
  let database: ReturnType<typeof createDatabase> | undefined;
  let writeAttempts = 0;
  let failedCheck: string | undefined;
  let activeCheck = 'harness.initialize';
  const writtenValues = new Map<SettingKey, unknown>();
  const writtenUpdatedAt = new Map<SettingKey, string>();
  const actorSuffix = randomBytes(8).toString('hex');
  const actorRef = `script:app-config:w5-proof-${actorSuffix}`;
  const write = async (key: SettingKey, value: unknown, expectedUpdatedAt: string) => {
    if (writeAttempts >= MAX_WRITE_ATTEMPTS) throw new ProofFailure('db.write_budget');
    // Count attempts before the network operation so an ambiguous commit is still budgeted.
    writeAttempts += 1;
    await writeSetting(adminPool as Pool, key, value, expectedUpdatedAt, actorRef);
  };

  try {
    activeCheck = 'live_ready_required';
    addCheck(checks, 'live_ready_required', process.env.W5_APP_CONFIG_LIVE_READY === '1');

    activeCheck = 'input.target';
    const runtimeInput = parseDatabaseInput(RUNTIME_INPUT_PATH, 'api_runtime');
    const adminInput = parseDatabaseInput(ADMIN_INPUT_PATH, 'supabase_admin');
    addCheck(checks, 'input.target', true);

    activeCheck = 'db.snapshot';
    adminPool = createAdminPool(adminInput);
    snapshots = await readAllSettings(adminPool);
    addCheck(checks, 'db.snapshot', true);

    activeCheck = 'db.key_allow_list_parity';
    const allowLists = await readDatabaseKeyAllowLists(adminPool);
    const exportedKeys: readonly string[] = [...APP_CONFIG_KEYS];
    const schemaKeys = Object.keys(appConfigValueSchemas);
    addCheck(
      checks,
      'db.key_allow_list_parity',
      sameStringSet(exportedKeys, SETTING_KEYS) &&
        sameStringSet(schemaKeys, exportedKeys) &&
        sameStringSet(allowLists.tableConstraintKeys, exportedKeys) &&
        sameStringSet(allowLists.functionGuardKeys, exportedKeys),
    );

    activeCheck = 'db.fixture_writer_scope';
    const adminIdentity = await adminPool.query<{ current_user: string; database_name: string }>(
      'select current_user, current_database() as database_name',
    );
    addCheck(
      checks,
      'db.fixture_writer_scope',
      adminIdentity.rows[0]?.current_user === 'supabase_admin' &&
        adminIdentity.rows[0]?.database_name === 'postgres',
    );

    activeCheck = 'db.write_budget';
    addCheck(
      checks,
      'db.write_budget',
      writeAttempts + 8 <= MAX_WRITE_ATTEMPTS && MAX_WRITE_ATTEMPTS < 20,
    );

    activeCheck = 'db.initial_versions';
    let current = await readSetting(adminPool, 'versions');
    await write('versions', versions('2.0.0', '2.0.1'), current.updatedAt);
    writtenValues.set('versions', versions('2.0.0', '2.0.1'));
    writtenUpdatedAt.set('versions', (await readSetting(adminPool, 'versions')).updatedAt);
    addCheck(checks, 'db.initial_versions', true);

    activeCheck = 'db.initial_maintenance';
    current = await readSetting(adminPool, 'maintenance');
    await write('maintenance', maintenance(false, ['ios', 'android']), current.updatedAt);
    writtenValues.set('maintenance', maintenance(false, ['ios', 'android']));
    writtenUpdatedAt.set('maintenance', (await readSetting(adminPool, 'maintenance')).updatedAt);
    addCheck(checks, 'db.initial_maintenance', true);

    activeCheck = 'db.runtime_reader';
    const logger = createHarnessLogger(logs);
    database = createDatabase(
      {
        DATABASE_URL: runtimeInput.DATABASE_URL,
        DATABASE_CA_CERT: runtimeInput.DATABASE_CA_CERT,
      },
      { extensionSystemRoles: serverExtensionComposition.extensionSystemRoles, logger },
    );
    let clockMs = 0;
    const composition = createCoreComposition({
      database,
      logger,
      now: () => new Date(clockMs),
    });
    const baseDependencies = createDefaultRouteDependencies();
    let authenticateCalls = 0;
    const routeDependencies: RouteDependencies = {
      ...baseDependencies,
      now: () => new Date(clockMs),
      requestId: () => createUuidV7(),
      logger,
      rateLimiter: createHarnessRateLimiter(),
      async authenticateUser(token, requestContext) {
        authenticateCalls += 1;
        return baseDependencies.authenticateUser(token, requestContext);
      },
      async checkVersionAndMaintenance(input) {
        if (input.operationId === 'getHealth' || input.operationId === 'getAppConfig') {
          return baseDependencies.checkVersionAndMaintenance(input);
        }
        return composition.checkAppConfigGate({
          request: input.request,
          maintenance: input.maintenance,
        });
      },
    };
    const defineRoute = createDefineRoute(routeDependencies);
    const definitions = createCoreRouteDefinitions(
      () => composition,
      () => composition.getPublicAppConfig(),
    );
    const appConfigRoute = defineRoute(definitions.getAppConfig);
    const meRoute = defineRoute(definitions.getMe);
    const healthEndpoint = coreEndpoints.find((endpoint) => endpoint.operationId === 'getHealth');
    if (!healthEndpoint) throw new ProofFailure('route.health_contract');
    const healthRoute = defineRoute({
      operationId: healthEndpoint.operationId,
      auth: { kind: 'public' },
      rateLimit: healthEndpoint.rateLimit,
      output: healthEndpoint.responseSchema,
      handler: async () => ({ status: 'ok' as const }),
    });
    addCheck(checks, 'db.runtime_reader', true);

    activeCheck = 'route.public_config';
    const iosConfigResponse = await appConfigRoute(request('/api/v1/app-config?client=ios'));
    const iosConfig = await jsonBody(iosConfigResponse);
    const androidConfigResponse = await appConfigRoute(
      request('/api/v1/app-config?client=android'),
    );
    const androidConfig = await jsonBody(androidConfigResponse);
    addCheck(
      checks,
      'route.public_config',
      iosConfigResponse.status === 200 &&
        iosConfigResponse.headers.get('cache-control') ===
          'public, s-maxage=60, stale-while-revalidate=60' &&
        isDeepStrictEqual(iosConfig, androidConfig),
      { status: iosConfigResponse.status },
    );
    addCheck(checks, 'route.published_absent', isNoPublishedField(iosConfig));

    activeCheck = 'route.numeric_minimum';
    const tooOld = await meRoute(
      request('/api/v1/me', 'GET', { 'x-platform': 'ios', 'x-app-version': '1.9.99' }),
    );
    const tooOldBody = await jsonBody(tooOld);
    addCheck(
      checks,
      'route.numeric_minimum',
      tooOld.status === 426 && responseCode(tooOldBody) === 'app.update_required',
      { status: tooOld.status, code: responseCode(tooOldBody) },
    );

    activeCheck = 'cache.before_ttl';
    current = await readSetting(adminPool, 'versions');
    const refreshedVersions = versions('3.0.0', '3.0.1');
    await write('versions', refreshedVersions, current.updatedAt);
    writtenValues.set('versions', refreshedVersions);
    writtenUpdatedAt.set('versions', (await readSetting(adminPool, 'versions')).updatedAt);
    const beforeTtlResponse = await appConfigRoute(request('/api/v1/app-config'));
    const beforeTtl = await jsonBody(beforeTtlResponse);
    const beforeTtlCached =
      isRecord(beforeTtl) &&
      isRecord(beforeTtl.versions) &&
      isRecord(beforeTtl.versions.ios) &&
      beforeTtl.versions.ios.minSupported === '2.0.0';
    addCheck(checks, 'cache.before_ttl', beforeTtlCached, { status: beforeTtlResponse.status });

    activeCheck = 'cache.after_30000ms';
    clockMs += 30_000;
    const afterTtlResponse = await appConfigRoute(request('/api/v1/app-config'));
    const afterTtl = await jsonBody(afterTtlResponse);
    const afterTtlFresh =
      isRecord(afterTtl) &&
      isRecord(afterTtl.versions) &&
      isRecord(afterTtl.versions.ios) &&
      afterTtl.versions.ios.minSupported === '3.0.0';
    addCheck(checks, 'cache.after_30000ms', afterTtlFresh, { status: afterTtlResponse.status });

    activeCheck = 'gate.per_platform_maintenance';
    current = await readSetting(adminPool, 'maintenance');
    const iosMaintenance = maintenance(true, ['ios']);
    await write('maintenance', iosMaintenance, current.updatedAt);
    writtenValues.set('maintenance', iosMaintenance);
    writtenUpdatedAt.set('maintenance', (await readSetting(adminPool, 'maintenance')).updatedAt);
    clockMs += 30_000;
    const iosDuringMaintenance = await meRoute(
      request('/api/v1/me', 'GET', { 'x-platform': 'ios', 'x-app-version': '3.0.0' }),
    );
    const iosMaintenanceBody = await jsonBody(iosDuringMaintenance);
    const androidDuringMaintenance = await meRoute(
      request('/api/v1/me', 'GET', { 'x-platform': 'android', 'x-app-version': '3.0.0' }),
    );
    const androidMaintenanceBody = await jsonBody(androidDuringMaintenance);
    addCheck(
      checks,
      'gate.per_platform_maintenance',
      iosDuringMaintenance.status === 503 &&
        responseCode(iosMaintenanceBody) === 'app.maintenance' &&
        androidDuringMaintenance.status === 401 &&
        responseCode(androidMaintenanceBody) === 'auth.missing_token',
      { status: iosDuringMaintenance.status, code: responseCode(iosMaintenanceBody) },
    );

    activeCheck = 'gate.per_platform_invalid_headers';
    const invalidPlatformDuringScopedMaintenance = await meRoute(
      request('/api/v1/me', 'GET', { 'x-platform': 'iosx', 'x-app-version': 'not-semver' }),
    );
    const invalidPlatformBody = await jsonBody(invalidPlatformDuringScopedMaintenance);
    addCheck(
      checks,
      'gate.per_platform_invalid_headers',
      invalidPlatformDuringScopedMaintenance.status === 401 &&
        responseCode(invalidPlatformBody) === 'auth.missing_token',
      {
        status: invalidPlatformDuringScopedMaintenance.status,
        code: responseCode(invalidPlatformBody),
      },
    );

    activeCheck = 'gate.global_maintenance';
    current = await readSetting(adminPool, 'maintenance');
    const globalMaintenance = maintenance(true, ['ios', 'android']);
    await write('maintenance', globalMaintenance, current.updatedAt);
    writtenValues.set('maintenance', globalMaintenance);
    writtenUpdatedAt.set('maintenance', (await readSetting(adminPool, 'maintenance')).updatedAt);
    clockMs += 30_000;
    const globalProbe = await meRoute(
      request('/api/v1/me', 'GET', { 'x-platform': 'ios', 'x-app-version': '3.0.0' }),
    );
    const globalProbeBody = await jsonBody(globalProbe);
    addCheck(
      checks,
      'gate.global_maintenance',
      globalProbe.status === 503 &&
        responseCode(globalProbeBody) === 'app.maintenance' &&
        globalProbe.headers.get('retry-after') === '60',
      {
        status: globalProbe.status,
        code: responseCode(globalProbeBody),
        retryAfter: globalProbe.headers.get('retry-after') ?? undefined,
      },
    );

    activeCheck = 'gate.global_maintenance_invalid_headers';
    const globalWithInvalidHeaders = await meRoute(
      request('/api/v1/me', 'GET', { 'x-platform': 'web', 'x-app-version': 'bad' }),
    );
    const globalInvalidBody = await jsonBody(globalWithInvalidHeaders);
    addCheck(
      checks,
      'gate.global_maintenance_invalid_headers',
      globalWithInvalidHeaders.status === 503 &&
        responseCode(globalInvalidBody) === 'app.maintenance' &&
        globalWithInvalidHeaders.headers.get('retry-after') === '60',
      {
        status: globalWithInvalidHeaders.status,
        code: responseCode(globalInvalidBody),
        retryAfter: globalWithInvalidHeaders.headers.get('retry-after') ?? undefined,
      },
    );

    activeCheck = 'gate.maintenance_all_methods';
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
    const methodResults: Response[] = [];
    for (const method of methods) methodResults.push(await meRoute(request('/api/v1/me', method)));
    const methodBodies = await Promise.all(methodResults.map(jsonBody));
    addCheck(
      checks,
      'gate.maintenance_all_methods',
      methodResults.every(
        (response, index) =>
          response.status === 503 &&
          response.headers.get('retry-after') === '60' &&
          responseCode(methodBodies[index]) === 'app.maintenance',
      ),
      {
        status: methodResults[0]?.status,
        retryAfter: methodResults[0]?.headers.get('retry-after') ?? undefined,
      },
    );

    activeCheck = 'gate.health_exemption';
    const healthResponse = await healthRoute(request('/api/v1/health'));
    const healthBody = await jsonBody(healthResponse);
    addCheck(
      checks,
      'gate.health_exemption',
      healthResponse.status === 200 && isRecord(healthBody) && healthBody.status === 'ok',
      { status: healthResponse.status },
    );

    activeCheck = 'gate.app_config_exemption';
    const configDuringMaintenance = await appConfigRoute(request('/api/v1/app-config'));
    const configDuringMaintenanceBody = await jsonBody(configDuringMaintenance);
    addCheck(
      checks,
      'gate.app_config_exemption',
      configDuringMaintenance.status === 200 &&
        isRecord(configDuringMaintenanceBody) &&
        isRecord(configDuringMaintenanceBody.maintenance) &&
        configDuringMaintenanceBody.maintenance.active === true,
      { status: configDuringMaintenance.status },
    );

    activeCheck = 'fallback.invalid_setting';
    current = await readSetting(adminPool, 'maintenance');
    const sqlAcceptedButSchemaInvalid = {
      ...globalMaintenance,
      unexpectedField: 'invalid_for_application_schema',
    };
    await write('maintenance', sqlAcceptedButSchemaInvalid, current.updatedAt);
    writtenValues.set('maintenance', sqlAcceptedButSchemaInvalid);
    writtenUpdatedAt.set('maintenance', (await readSetting(adminPool, 'maintenance')).updatedAt);
    clockMs += 30_000;
    const fallbackResponse = await appConfigRoute(request('/api/v1/app-config'));
    const fallbackBody = await jsonBody(fallbackResponse);
    const invalidSettingObserved = logs.some(
      (entry) =>
        entry.level === 'warn' &&
        entry.message === 'Invalid app configuration setting; using fallback.' &&
        entry.fields.key === 'maintenance',
    );
    addCheck(
      checks,
      'fallback.invalid_setting',
      fallbackResponse.status === 200 &&
        isRecord(fallbackBody) &&
        isRecord(fallbackBody.maintenance) &&
        fallbackBody.maintenance.active === true &&
        !Object.hasOwn(fallbackBody.maintenance, 'unexpectedField') &&
        invalidSettingObserved,
      { status: fallbackResponse.status },
    );

    activeCheck = 'auth.not_reached_on_block';
    addCheck(checks, 'auth.not_reached_on_block', authenticateCalls === 0);
  } catch (error) {
    failedCheck = error instanceof ProofFailure ? error.checkName : activeCheck;
    recordFailure(checks, failedCheck);
  } finally {
    if (adminPool && snapshots) {
      let cleanupFailure: string | undefined;
      try {
        for (const key of SETTING_KEYS) {
          const original = snapshots[key];
          const current = await readSetting(adminPool, key);
          if (isDeepStrictEqual(current.value, original.value)) continue;

          const lastWrittenValue = writtenValues.get(key);
          const lastWrittenAt = writtenUpdatedAt.get(key);
          if (
            lastWrittenAt === undefined ||
            current.updatedAt !== lastWrittenAt ||
            !isDeepStrictEqual(current.value, lastWrittenValue)
          ) {
            cleanupFailure = 'cleanup.concurrent_change';
            break;
          }
          if (writeAttempts >= MAX_WRITE_ATTEMPTS) {
            cleanupFailure = 'cleanup.write_budget';
            break;
          }
          await write(key, original.value, current.updatedAt);
          writtenValues.set(key, cloneJson(original.value));
          writtenUpdatedAt.set(key, (await readSetting(adminPool, key)).updatedAt);
        }
        if (cleanupFailure === undefined) {
          const restored = await readAllSettings(adminPool);
          addCheck(
            checks,
            'cleanup.original_settings_restored',
            SETTING_KEYS.every((key) =>
              isDeepStrictEqual(restored[key].value, snapshots?.[key].value),
            ),
          );
        } else {
          failedCheck ??= cleanupFailure;
          recordFailure(checks, cleanupFailure);
        }
      } catch (error) {
        const checkName = error instanceof ProofFailure ? error.checkName : 'cleanup.restore';
        failedCheck ??= checkName;
        recordFailure(checks, checkName);
      }
    }

    if (database) {
      try {
        await database.destroy();
      } catch {
        failedCheck ??= 'cleanup.runtime_close';
        recordFailure(checks, 'cleanup.runtime_close');
      }
    }
    if (adminPool) {
      try {
        await adminPool.end();
      } catch {
        failedCheck ??= 'cleanup.admin_close';
        recordFailure(checks, 'cleanup.admin_close');
      }
    }
  }

  const passed = failedCheck === undefined && checks.every((check) => check.passed);
  return {
    passed,
    target: '127.0.0.1:55452/postgres',
    runtimeRole: 'api_runtime',
    writerRole: 'app_config_writer',
    writeAttempts,
    checks,
    ...(failedCheck === undefined ? {} : { failedCheck }),
  };
}

const result = await runProof();
process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result)}\n`);
if (!result.passed) process.exitCode = 1;
