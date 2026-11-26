import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { AppConfigKey, CurrentSettingSnapshot, RollbackSource } from './operation';
import { AppConfigOperatorError, type AppConfigOperatorEnvironment } from './environment';
import type { AppConfigMutationPort } from './plan';

type SqlResult = Readonly<{
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}>;

interface AppConfigSqlClient {
  query(text: string, values?: unknown[]): Promise<SqlResult>;
  release(): void;
}

export interface AppConfigSqlPool {
  connect(): Promise<AppConfigSqlClient>;
  end(): Promise<void>;
}

const APP_CONFIG_WRITER_ROLE = 'app_config_writer';
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function withWriterTransaction<T>(
  pool: AppConfigSqlPool,
  expectedLogin: string,
  operation: (client: AppConfigSqlClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let transactionStarted = false;
  let transactionFinished = false;
  try {
    await client.query('begin isolation level read committed');
    transactionStarted = true;
    await assertDedicatedLogin(client, expectedLogin);
    await client.query("select pg_catalog.set_config('role', $1, true)", [APP_CONFIG_WRITER_ROLE]);
    const result = await operation(client);
    await client.query('commit');
    transactionFinished = true;
    return result;
  } catch (error) {
    if (transactionStarted && !transactionFinished) {
      try {
        await client.query('rollback');
      } catch {
        // Preserve the original operation result and keep driver details private.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

async function assertDedicatedLogin(
  client: AppConfigSqlClient,
  expectedLogin: string,
): Promise<void> {
  const login = await client.query(
    "select role_info.rolname::text as login_name, role_info.rolcanlogin, role_info.rolsuper, role_info.rolbypassrls, role_info.rolcreaterole, role_info.rolcreatedb, role_info.rolreplication, pg_catalog.pg_has_role(session_user, 'app_config_writer', 'SET') as can_set_writer from pg_catalog.pg_roles as role_info where role_info.rolname = session_user",
  );
  if (login.rows.length !== 1) {
    throw new AppConfigOperatorError(
      'app_config.login_scope',
      'The database login does not match the dedicated app-config operator role.',
    );
  }
  const row = login.rows[0]!;
  const booleanFlags = [
    row.rolcanlogin,
    row.rolsuper,
    row.rolbypassrls,
    row.rolcreaterole,
    row.rolcreatedb,
    row.rolreplication,
    row.can_set_writer,
  ];
  if (
    row.login_name !== expectedLogin ||
    row.login_name === 'postgres' ||
    booleanFlags[0] !== true ||
    booleanFlags.slice(1, 6).some((flag) => flag !== false) ||
    booleanFlags[6] !== true
  ) {
    throw new AppConfigOperatorError(
      'app_config.login_scope',
      'The database login does not match the dedicated app-config operator role.',
    );
  }
  const memberships = await client.query(
    "select member_role.rolname::text as role_name from pg_catalog.pg_roles as member_role where pg_catalog.pg_has_role(session_user, member_role.oid, 'MEMBER') and member_role.rolname <> session_user order by member_role.rolname",
  );
  if (memberships.rows.length !== 1 || memberships.rows[0]?.role_name !== APP_CONFIG_WRITER_ROLE) {
    throw new AppConfigOperatorError(
      'app_config.login_scope',
      'The database login does not have the approved app-config-only membership.',
    );
  }
}

function requireSnapshotRow(row: Record<string, unknown>): CurrentSettingSnapshot {
  if (!Object.hasOwn(row, 'value') || typeof row.updated_at !== 'string') {
    throw new Error('invalid read_setting result');
  }
  return { value: row.value, updatedAt: row.updated_at };
}

export function createPostgresAppConfigAdapter(
  pool: AppConfigSqlPool,
  expectedLogin: string,
): AppConfigMutationPort {
  return Object.freeze({
    async readCurrent(key: AppConfigKey): Promise<CurrentSettingSnapshot> {
      return withWriterTransaction(pool, expectedLogin, async (client) => {
        const result = await client.query(
          'select value, updated_at::text as updated_at from app_config.read_setting($1::text)',
          [key],
        );
        if (result.rows.length === 0) return { value: null, updatedAt: null };
        if (result.rows.length !== 1) throw new Error('read_setting returned multiple rows');
        return requireSnapshotRow(result.rows[0]!);
      });
    },

    async readLatestRollbackSource(key: AppConfigKey): Promise<RollbackSource | null> {
      return withWriterTransaction(pool, expectedLogin, async (client) => {
        const result = await client.query(
          'select event_id::text as event_id, before_value, after_value, occurred_at::text as occurred_at from app_config.read_rollback_setting($1::text)',
          [key],
        );
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1)
          throw new Error('read_rollback_setting returned multiple rows');
        const row = result.rows[0]!;
        if (
          typeof row.event_id !== 'string' ||
          !SAFE_UUID.test(row.event_id) ||
          typeof row.occurred_at !== 'string' ||
          !Object.hasOwn(row, 'before_value') ||
          !Object.hasOwn(row, 'after_value')
        ) {
          throw new Error('invalid read_rollback_setting result');
        }
        return {
          eventId: row.event_id,
          key,
          before: row.before_value,
          after: row.after_value,
        };
      });
    },

    async writeSetting(input: Parameters<AppConfigMutationPort['writeSetting']>[0]): Promise<void> {
      await withWriterTransaction(pool, expectedLogin, async (client) => {
        await client.query(
          'select app_config.set_setting($1::text, $2::jsonb, $3::text, $4::text, $5::text, $6::timestamptz, $7::boolean)',
          [
            input.key,
            JSON.stringify(input.value),
            'system',
            input.actorRef,
            input.correlationId,
            input.expectedUpdatedAt,
            input.force,
          ],
        );
      });
    },
  });
}

export function createAppConfigAdminPool(environment: AppConfigOperatorEnvironment): Pool {
  const config = createAppConfigAdminPoolConfig(environment);
  return new Pool(config);
}

export function createAppConfigAdminPoolConfig(
  environment: AppConfigOperatorEnvironment,
): PoolConfig {
  return {
    host: environment.database.host,
    port: environment.database.port,
    database: environment.database.database,
    user: environment.database.user,
    password: environment.database.password,
    application_name: 'base-app-app-config-operator',
    options: '-c statement_timeout=10000',
    ssl: { ca: environment.databaseCaCertificate, rejectUnauthorized: true },
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    query_timeout: 12_000,
    statement_timeout: 10_000,
  };
}

export function adaptPgPool(pool: Pool): AppConfigSqlPool {
  return {
    async connect() {
      const client: PoolClient = await pool.connect();
      return client as unknown as AppConfigSqlClient;
    },
    async end() {
      await pool.end();
    },
  };
}

export function isPostgresConflict(error: unknown): boolean {
  return isObject(error) && error.code === 'AC409';
}
