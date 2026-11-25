import { describe, expect, it, vi } from 'vitest';
import { TypeOverrides, types, type Pool } from 'pg';
import { sql } from 'kysely';

import type { AppLogger } from '../observability/logger';
import type { ExtensionSystemRole } from '../kernel/extension-system-role';
import type { DatabaseEnvironment } from '../env/index';
import type { CoreSystemContext, DbClaims, DbTransaction } from './index';
import {
  createDatabaseRuntime,
  createDatabasePoolConfig,
  parseUserDbClaims,
  resolveSystemRole,
} from './runtime';

const TEST_ENVIRONMENT: DatabaseEnvironment = {
  DATABASE_URL: 'postgresql://api_runtime:secret@db.example.invalid:6543/postgres',
  DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nlocal-test-ca\n-----END CERTIFICATE-----',
};

const VALID_CLAIMS: DbClaims = {
  sub: '5b3276c3-0f2b-4e86-86ac-28beb418ab67',
  role: 'authenticated',
  aal: 'aal2',
  session_id: 'b19ed338-3e7f-4f40-90d8-7f12c5707fb4',
};

type QueryCall = { readonly text: string; readonly values: readonly unknown[] };

function createFakePool(): {
  readonly pool: Pool;
  readonly calls: QueryCall[];
  readonly released: ReturnType<typeof vi.fn>;
} {
  const calls: QueryCall[] = [];
  const released = vi.fn();
  const client = {
    query: async (query: string | { readonly text: string }, values?: readonly unknown[]) => {
      calls.push({ text: typeof query === 'string' ? query : query.text, values: values ?? [] });
      return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
    },
    release: released,
  };
  const pool = {
    connect: vi.fn(async () => client),
    on: vi.fn(),
    end: vi.fn(async () => undefined),
  } as unknown as Pool;
  return { pool, calls, released };
}

function createLogger(): AppLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createRuntime(
  extensionSystemRoles: readonly ExtensionSystemRole[] = [],
  pool: Pool = createFakePool().pool,
) {
  const attachDatabasePool = vi.fn();
  const logger = createLogger();
  const runtime = createDatabaseRuntime(
    TEST_ENVIRONMENT,
    { extensionSystemRoles, logger },
    {
      createPool: vi.fn(() => pool),
      attachDatabasePool,
    },
  );
  return { runtime, attachDatabasePool, logger };
}

describe('database runtime configuration', () => {
  it('requires verified TLS, bounded pool capacity, finite timeouts, and pool-scoped timestamp strings', () => {
    const config = createDatabasePoolConfig(TEST_ENVIRONMENT);

    expect(config.connectionString).toBe(TEST_ENVIRONMENT.DATABASE_URL);
    expect(config.ssl).toEqual({ ca: TEST_ENVIRONMENT.DATABASE_CA_CERT, rejectUnauthorized: true });
    expect(config.max).toBe(3);
    expect(config.connectionTimeoutMillis).toBe(3_000);
    expect(config.query_timeout).toBe(20_000);
    expect(config.statement_timeout).toBe(20_000);
    expect(config.idle_in_transaction_session_timeout).toBe(20_000);
    expect(config.types).toBeInstanceOf(TypeOverrides);
    expect(
      config.types?.getTypeParser(types.builtins.TIMESTAMPTZ)('2026-11-25T12:34:56.123456+00'),
    ).toBe('2026-11-25T12:34:56.123456+00');
    expect(
      config.types?.getTypeParser(types.builtins.TIMESTAMP)('2026-11-25 12:34:56.123456'),
    ).toBe('2026-11-25 12:34:56.123456');
  });

  it.each(['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'SSLMODE'])(
    'rejects connection URI TLS override parameter %s',
    (parameter) => {
      expect(() =>
        createDatabasePoolConfig({
          ...TEST_ENVIRONMENT,
          DATABASE_URL: `${TEST_ENVIRONMENT.DATABASE_URL}?${parameter}=disable`,
        }),
      ).toThrow('Invalid database connection configuration.');
    },
  );

  it('rejects malformed connection URLs and empty CA data without exposing configuration', () => {
    expect(() =>
      createDatabasePoolConfig({ ...TEST_ENVIRONMENT, DATABASE_URL: 'not-a-database-url' }),
    ).toThrow('Invalid database connection configuration.');
    expect(() =>
      createDatabasePoolConfig({ ...TEST_ENVIRONMENT, DATABASE_CA_CERT: '   ' }),
    ).toThrow('Invalid database connection configuration.');
  });
});

describe('database scope validation', () => {
  it('accepts only the four validated JWT database claims', () => {
    expect(parseUserDbClaims(VALID_CLAIMS)).toEqual(VALID_CLAIMS);
  });

  it('rejects injected claim values and discarded identity fields before acquiring a connection', async () => {
    const fake = createFakePool();
    const { runtime } = createRuntime([], fake.pool);

    await expect(
      runtime.userScopedDb(
        {
          ...VALID_CLAIMS,
          sub: "5b3276c3-0f2b-4e86-86ac-28beb418ab67'; select pg_sleep(30); --",
        } as DbClaims,
        async () => 'unreachable',
      ),
    ).rejects.toThrow('Invalid database user claims.');
    await expect(
      runtime.userScopedDb(
        { ...VALID_CLAIMS, user_metadata: { locale: "'; select pg_sleep(30); --" } } as DbClaims,
        async () => 'unreachable',
      ),
    ).rejects.toThrow('Invalid database user claims.');
    expect(fake.pool.connect).not.toHaveBeenCalled();
  });

  it('resolves only fixed core roles and extension roles present in the frozen allowlist', () => {
    expect(resolveSystemRole('identity', [])).toBe('identity_system');
    expect(resolveSystemRole('privacy', [])).toBe('privacy_system');
    expect(resolveSystemRole('app-config', [])).toBe('app_config_system');
    expect(resolveSystemRole('platform', [])).toBe('platform_system');
    expect(
      resolveSystemRole(
        'inventory_system' as ExtensionSystemRole,
        ['inventory_system'] as ExtensionSystemRole[],
      ),
    ).toBe('inventory_system');
    expect(() => resolveSystemRole('ops' as CoreSystemContext, [])).toThrow(
      'Invalid system database context.',
    );
    expect(() => resolveSystemRole('inventory_system' as ExtensionSystemRole, [])).toThrow(
      'Invalid system database context.',
    );
    expect(() =>
      resolveSystemRole("bad'; select pg_sleep(30); --" as ExtensionSystemRole, []),
    ).toThrow('Invalid system database context.');
  });

  it('rejects an invalid extension allowlist before creating a pool', () => {
    const createPool = vi.fn(() => createFakePool().pool);
    const attachDatabasePool = vi.fn();

    expect(() =>
      createDatabaseRuntime(
        TEST_ENVIRONMENT,
        {
          extensionSystemRoles: ["bad';select true;--" as ExtensionSystemRole],
          logger: createLogger(),
        },
        { createPool, attachDatabasePool },
      ),
    ).toThrow('Invalid extension system role allowlist.');
    expect(createPool).not.toHaveBeenCalled();
  });

  it('copies its extension role allowlist so later caller mutation cannot grant access', async () => {
    const fake = createFakePool();
    const extensionSystemRoles = ['inventory_system'] as ExtensionSystemRole[];
    const runtime = createDatabaseRuntime(
      TEST_ENVIRONMENT,
      { extensionSystemRoles, logger: createLogger() },
      { createPool: () => fake.pool, attachDatabasePool: vi.fn() },
    );
    extensionSystemRoles.push('unexpected_system' as ExtensionSystemRole);

    await expect(
      runtime.systemDb('unexpected_system' as ExtensionSystemRole, async () => undefined),
    ).rejects.toThrow('Invalid system database context.');
    expect(fake.pool.connect).not.toHaveBeenCalled();
    await runtime.destroy();
  });
});

describe('database transaction scope', () => {
  it('attaches one pool and binds role and minimal claims inside each transaction', async () => {
    const fake = createFakePool();
    const { runtime, attachDatabasePool } = createRuntime([], fake.pool);

    await runtime.userScopedDb(VALID_CLAIMS, async () => 'user-result');
    await runtime.systemDb('platform', async () => 'system-result');

    expect(attachDatabasePool).toHaveBeenCalledOnce();
    expect(attachDatabasePool).toHaveBeenCalledWith(fake.pool);
    const settings = fake.calls.filter(({ text }) => text.includes('set_config'));
    expect(settings).toHaveLength(2);
    expect(settings[0]?.text).toMatch(/set_config\('role',\s*\$1,\s*true\)/);
    expect(settings[0]?.text).toMatch(/set_config\('request\.jwt\.claims',\s*\$2,\s*true\)/);
    expect(settings[0]?.values).toEqual(['authenticated', JSON.stringify(VALID_CLAIMS)]);
    expect(settings[1]?.text).toMatch(/set_config\('role',\s*\$1,\s*true\)/);
    expect(settings[1]?.text).toMatch(/set_config\('request\.jwt\.claims',\s*\$2,\s*true\)/);
    expect(settings[1]?.values).toEqual(['platform_system', '{}']);
    expect(fake.calls.map(({ text }) => text)).toContain('begin');
    expect(fake.calls.map(({ text }) => text)).toContain('commit');
    expect(fake.calls.some(({ text }) => /^\s*set\s/i.test(text))).toBe(false);
  });

  it('rolls back and releases the connection when scoped work throws', async () => {
    const fake = createFakePool();
    const { runtime } = createRuntime([], fake.pool);
    const failure = new Error('expected unit failure');

    await expect(
      runtime.userScopedDb(VALID_CLAIMS, async () => Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(fake.calls.map(({ text }) => text)).toContain('rollback');
    expect(fake.calls.map(({ text }) => text)).not.toContain('commit');
    expect(fake.released).toHaveBeenCalledOnce();
  });

  it('keeps arbitrary user data out of query text and passes any accepted claims as a bind value', async () => {
    const fake = createFakePool();
    const { runtime } = createRuntime([], fake.pool);
    const malicious = "'; select pg_sleep(30); --";
    const rejected = { ...VALID_CLAIMS, user_metadata: { display_name: malicious } };

    await expect(
      runtime.userScopedDb(rejected as DbClaims, async () => undefined),
    ).rejects.toThrow();
    await runtime.userScopedDb(VALID_CLAIMS, async (trx) => {
      await sql`select ${malicious}`.execute(trx);
    });
    const bound = fake.calls.find(({ text }) => text.includes('select $1'));
    expect(bound?.text).toContain('$1');
    expect(bound?.text).not.toContain(malicious);
    expect(bound?.values).toEqual([malicious]);
  });

  it('logs only a sanitized error name and SQLSTATE from background pool errors', () => {
    const fake = createFakePool();
    const logger = createLogger();
    let onPoolError: ((error: Error & { readonly code?: string }) => void) | undefined;
    fake.pool.on = vi.fn(
      (event: string, listener: (error: Error & { readonly code?: string }) => void) => {
        if (event === 'error') onPoolError = listener;
        return fake.pool;
      },
    );
    createDatabaseRuntime(
      TEST_ENVIRONMENT,
      { extensionSystemRoles: [], logger },
      { createPool: () => fake.pool, attachDatabasePool: vi.fn() },
    );

    const driverError = Object.assign(new Error('postgres://user:password@host/secret query'), {
      name: 'DatabaseError',
      code: '08006',
    });
    onPoolError?.(driverError);

    expect(logger.error).toHaveBeenCalledWith('Database pool error.', {
      database_error_name: 'DatabaseError',
      database_error_code: '08006',
    });
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: expect.anything(), query: expect.anything() }),
    );
  });
});

const integrationEnabled = process.env.DB_RUNTIME_INTEGRATION === '1';

describe.skipIf(!integrationEnabled)(
  'database runtime against the local transaction pooler',
  () => {
    it('restores transaction-local identity after commit and rollback', async () => {
      const { createDatabase } = await import('./index');
      const environment: DatabaseEnvironment = {
        DATABASE_URL: process.env.DATABASE_URL ?? '',
        DATABASE_CA_CERT: process.env.DATABASE_CA_CERT ?? '',
      };
      const database = createDatabase(environment, {
        extensionSystemRoles: [],
        logger: createLogger(),
      });
      const inspect = async (trx: DbTransaction) => {
        const result = await sql<{
          readonly current_role: string;
          readonly claims: string;
        }>`select current_user as current_role, current_setting('request.jwt.claims', true) as claims`.execute(
          trx,
        );
        return result.rows[0];
      };

      try {
        const userState = await database.userScopedDb(VALID_CLAIMS, inspect);
        expect(userState?.current_role).toBe('authenticated');
        expect(JSON.parse(userState?.claims ?? 'null')).toEqual(VALID_CLAIMS);
        await expect(
          database.userScopedDb(VALID_CLAIMS, async () => {
            throw new Error('rollback scope');
          }),
        ).rejects.toThrow('rollback scope');
        const state = await database.systemDb('platform', inspect);
        expect(state?.current_role).toBe('platform_system');
        expect(state?.claims).toBe('{}');
        const timestamp = await database.systemDb('platform', async (trx) => {
          const result = await sql<{
            readonly high_precision: string;
          }>`select '2026-11-25 12:34:56.123456+00'::timestamptz as high_precision`.execute(trx);
          return result.rows[0]?.high_precision;
        });
        expect(timestamp).toContain('.123456+00');
      } finally {
        await database.destroy();
      }
    });
  },
);
