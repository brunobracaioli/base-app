import { attachDatabasePool } from '@vercel/functions';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { Pool, TypeOverrides, types, type PoolConfig } from 'pg';

import type { DatabaseEnvironment } from '../env/index';
import type { ExtensionSystemRole } from '../kernel/extension-system-role';
import type { AppLogger } from '../observability/logger';
import type { DbClaims } from './claims';
import { parseUserDbClaims } from './claims';
import type { DB as Database } from './types';

export type CoreSystemContext = 'identity' | 'privacy' | 'app-config' | 'platform';
export type SystemDatabaseContext = CoreSystemContext | ExtensionSystemRole;
export type DbTransaction = Transaction<Database>;

export type DatabaseFactoryOptions = {
  readonly extensionSystemRoles: readonly ExtensionSystemRole[];
  readonly logger: AppLogger;
};

export type DatabaseRuntime = {
  userScopedDb<T>(claims: DbClaims, work: (transaction: DbTransaction) => Promise<T>): Promise<T>;
  systemDb<T>(
    context: SystemDatabaseContext,
    work: (transaction: DbTransaction) => Promise<T>,
  ): Promise<T>;
  destroy(): Promise<void>;
};

type DatabaseRuntimeDependencies = {
  readonly createPool: (configuration: PoolConfig) => Pool;
  readonly attachDatabasePool: (pool: Pool) => void;
};

const CORE_SYSTEM_ROLES: ReadonlyMap<CoreSystemContext, string> = new Map([
  ['identity', 'identity_system'],
  ['privacy', 'privacy_system'],
  ['app-config', 'app_config_system'],
  ['platform', 'platform_system'],
]);

const CORE_ROLE_NAMES = new Set(CORE_SYSTEM_ROLES.values());
const EXTENSION_ROLE_PATTERN = /^[a-z][a-z0-9_]{0,31}_system$/;
const DATABASE_POOL_SIZE = 3;
const CONNECTION_TIMEOUT_MS = 3_000;
const QUERY_TIMEOUT_MS = 20_000;
const STATEMENT_TIMEOUT_MS = 20_000;
const IDLE_TRANSACTION_TIMEOUT_MS = 20_000;
const LOCK_TIMEOUT_MS = 3_000;

function createTimestampTypeOverrides(): TypeOverrides {
  const typeOverrides = new TypeOverrides();
  typeOverrides.setTypeParser(types.builtins.TIMESTAMP, (value: string) => value);
  typeOverrides.setTypeParser(types.builtins.TIMESTAMPTZ, (value: string) => value);
  return typeOverrides;
}

function validateDatabaseEnvironment(environment: DatabaseEnvironment): void {
  let url: URL;
  try {
    url = new URL(environment.DATABASE_URL);
  } catch {
    throw new Error('Invalid database connection configuration.');
  }

  const sslOverrideParameters = new Set(['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert']);
  const hasTlsOverride = Array.from(url.searchParams.keys()).some((parameter) =>
    sslOverrideParameters.has(parameter.toLowerCase()),
  );
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname.length === 0 ||
    url.pathname.length <= 1 ||
    hasTlsOverride ||
    (environment.DATABASE_CA_CERT === null
      ? !isLoopbackDatabaseHost(url.hostname)
      : environment.DATABASE_CA_CERT.trim().length === 0)
  ) {
    throw new Error('Invalid database connection configuration.');
  }
}

/** Defense in depth: a connection without TLS is only ever built for the local loopback stack. */
function isLoopbackDatabaseHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

export function createDatabasePoolConfig(environment: DatabaseEnvironment): PoolConfig {
  validateDatabaseEnvironment(environment);
  return {
    connectionString: environment.DATABASE_URL,
    ssl:
      environment.DATABASE_CA_CERT === null
        ? false
        : {
            ca: environment.DATABASE_CA_CERT,
            rejectUnauthorized: true,
          },
    max: DATABASE_POOL_SIZE,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_TRANSACTION_TIMEOUT_MS,
    lock_timeout: LOCK_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    types: createTimestampTypeOverrides(),
  };
}

function freezeExtensionRoleAllowlist(
  extensionSystemRoles: readonly ExtensionSystemRole[],
): readonly ExtensionSystemRole[] {
  const roles = [...extensionSystemRoles];
  const seen = new Set<string>();
  for (const role of roles) {
    if (
      typeof role !== 'string' ||
      !EXTENSION_ROLE_PATTERN.test(role) ||
      CORE_ROLE_NAMES.has(role) ||
      seen.has(role)
    ) {
      throw new Error('Invalid extension system role allowlist.');
    }
    seen.add(role);
  }
  return Object.freeze(roles);
}

export function resolveSystemRole(
  context: SystemDatabaseContext,
  extensionSystemRoles: readonly ExtensionSystemRole[],
): string {
  if (typeof context !== 'string') throw new Error('Invalid system database context.');
  const coreRole = CORE_SYSTEM_ROLES.get(context as CoreSystemContext);
  if (coreRole !== undefined) return coreRole;
  if (extensionSystemRoles.some((role) => role === context)) return context;
  throw new Error('Invalid system database context.');
}

function sanitizedDriverError(error: Error & { readonly code?: string }): {
  readonly database_error_name: string;
  readonly database_error_code?: string;
} {
  const safeName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'Error';
  const safeCode = error.code && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : undefined;
  return {
    database_error_name: safeName,
    ...(safeCode === undefined ? {} : { database_error_code: safeCode }),
  };
}

export function createDatabaseRuntime(
  environment: DatabaseEnvironment,
  options: DatabaseFactoryOptions,
  dependencies: DatabaseRuntimeDependencies = {
    createPool: (configuration) => new Pool(configuration),
    attachDatabasePool,
  },
): DatabaseRuntime {
  const extensionRoles = freezeExtensionRoleAllowlist(options.extensionSystemRoles);
  const poolConfiguration = createDatabasePoolConfig(environment);
  const pool = dependencies.createPool(poolConfiguration);
  dependencies.attachDatabasePool(pool);
  pool.on('error', (error: Error & { readonly code?: string }) => {
    options.logger.error('Database pool error.', sanitizedDriverError(error));
  });

  const database = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

  async function runInScope<T>(
    role: string,
    claimsJson: string,
    work: (transaction: DbTransaction) => Promise<T>,
  ): Promise<T> {
    return database.transaction().execute(async (transaction) => {
      await sql`select set_config('role', ${role}, true), set_config('request.jwt.claims', ${claimsJson}, true)`.execute(
        transaction,
      );
      return work(transaction);
    });
  }

  const runtime: DatabaseRuntime = {
    async userScopedDb<T>(
      claims: DbClaims,
      work: (transaction: DbTransaction) => Promise<T>,
    ): Promise<T> {
      const validatedClaims = parseUserDbClaims(claims);
      return runInScope('authenticated', JSON.stringify(validatedClaims), work);
    },
    async systemDb<T>(
      context: SystemDatabaseContext,
      work: (transaction: DbTransaction) => Promise<T>,
    ): Promise<T> {
      const role = resolveSystemRole(context, extensionRoles);
      return runInScope(role, '{}', work);
    },
    destroy(): Promise<void> {
      return database.destroy();
    },
  };
  return Object.freeze(runtime);
}

export { parseUserDbClaims };
