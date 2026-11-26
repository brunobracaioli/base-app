import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { parseTrustRegistry, signApprovalEnvelope } from './approval';
import { signAfterDigestApproval } from './cli';
import {
  createAppConfigAdminPoolConfig,
  createPostgresAppConfigAdapter,
  type AppConfigSqlPool,
} from './database';
import {
  AppConfigOperatorError,
  assertOutsideCheckout,
  loadAppConfigSigningEnvironment,
  parseAppConfigDatabaseTarget,
  type AppConfigOperatorEnvironment,
} from './environment';
import { readProtectedFile } from './files';
import { parseJsonRejectDuplicateMembers } from './json';
import {
  planRollback,
  planSetChange,
  type AppConfigOperationPlan,
  type AppConfigKey,
} from './operation';
import {
  assertAppConfigApprovalContext,
  createAppConfigApprovalPlan,
  executeApprovedAppConfigPlan,
  type AppConfigApprovalEnvelope,
  type AppConfigMutationPort,
  type CheckoutBinding,
} from './plan';

const NOW = new Date('2026-11-25T12:00:00.000Z');
const UPDATED_AT = '2026-11-25 12:34:56.123456+00';
const OLD_LEGAL = { termsVersion: '2026-11-20', privacyVersion: '2026-11-20' };
const NEW_LEGAL = { termsVersion: '2026-11-25', privacyVersion: '2026-11-25' };
const TARGET = Object.freeze({
  host: 'db.example.invalid',
  port: 5432,
  database: 'postgres',
  username: 'app_config_operator',
  caSha256: 'a'.repeat(64),
});
const CHECKOUT: CheckoutBinding = Object.freeze({
  commit: 'b'.repeat(40),
  tree: 'c'.repeat(40),
  clean: true,
});
const ROLLBACK_EVENT_ID = '7c26fdb6-c767-4c99-9263-a375df9a23be';

function privateKeyPem(key: ReturnType<typeof generateKeyPairSync>['privateKey']): string {
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function publicKeyPem(key: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

function fingerprint(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('hex');
}

function trustFixture() {
  const first = generateKeyPairSync('ed25519');
  const second = generateKeyPairSync('ed25519');
  const trust = parseTrustRegistry({
    version: 1,
    identities: {
      operator_a: {
        publicKeyPem: publicKeyPem(first.publicKey),
        fingerprintSha256: fingerprint(first.publicKey),
      },
      operator_b: {
        publicKeyPem: publicKeyPem(second.publicKey),
        fingerprintSha256: fingerprint(second.publicKey),
      },
    },
  });
  return {
    trust,
    first: privateKeyPem(first.privateKey),
    second: privateKeyPem(second.privateKey),
  };
}

function setPlan(key: AppConfigKey = 'legal'): AppConfigOperationPlan {
  return planSetChange({
    key,
    proposedValue: NEW_LEGAL,
    current: { value: OLD_LEGAL, updatedAt: UPDATED_AT },
    force: false,
    now: NOW,
  });
}

async function signedEnvelope(plan: AppConfigOperationPlan = setPlan(), now: Date = NOW) {
  const { trust, first, second } = trustFixture();
  const unsigned = createAppConfigApprovalPlan({ plan, target: TARGET, checkout: CHECKOUT, now });
  const one = signApprovalEnvelope(unsigned, first, trust);
  const two = signApprovalEnvelope(one, second, trust);
  return { envelope: two as AppConfigApprovalEnvelope, trust };
}

function fakePort(
  input: {
    current?: { value: unknown | null; updatedAt: string | null };
    rollback?: { eventId: string; key: AppConfigKey; before: unknown; after: unknown } | null;
    writeError?: unknown;
  } = {},
) {
  const reads: string[] = [];
  const writes: Array<Parameters<AppConfigMutationPort['writeSetting']>[0]> = [];
  const port: AppConfigMutationPort = {
    async readCurrent(key) {
      reads.push(`current:${key}`);
      return input.current ?? { value: OLD_LEGAL, updatedAt: UPDATED_AT };
    },
    async readLatestRollbackSource(key) {
      reads.push(`rollback:${key}`);
      return input.rollback ?? null;
    },
    async writeSetting(setting) {
      writes.push(setting);
      if (input.writeError !== undefined) throw input.writeError;
    },
  };
  return { port, reads, writes };
}

describe('app-config operator command inputs and approval context', () => {
  it('requires the exact reviewed digest before invoking a signer', async () => {
    const digest = 'd'.repeat(64);
    const sign = vi.fn(() => 'signed');
    await expect(signAfterDigestApproval(digest, undefined, sign)).rejects.toThrow(/exact digest/);
    expect(sign).not.toHaveBeenCalled();
    await expect(signAfterDigestApproval(digest, 'e'.repeat(64), sign)).rejects.toThrow(
      /does not match/,
    );
    expect(sign).not.toHaveBeenCalled();
    await expect(signAfterDigestApproval(digest, digest, sign)).resolves.toBe('signed');
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate JSON object members before parsing signed or user-supplied JSON', () => {
    expect(() => parseJsonRejectDuplicateMembers('{"key":"first","key":"second"}')).toThrow(
      AppConfigOperatorError,
    );
    expect(parseJsonRejectDuplicateMembers('{"nested":{"value":1},"array":[true,null]}')).toEqual({
      nested: { value: 1 },
      array: [true, null],
    });
  });

  it('rejects relative and checkout-local approval artifact paths', () => {
    expect(() => assertOutsideCheckout('plans/approval.json', '/work/base-app')).toThrow(
      AppConfigOperatorError,
    );
    expect(() =>
      assertOutsideCheckout('/work/base-app/.private/approval.json', '/work/base-app'),
    ).toThrow(AppConfigOperatorError);
    expect(assertOutsideCheckout('/var/lib/app-config/approval.json', '/work/base-app')).toBe(
      '/var/lib/app-config/approval.json',
    );
  });

  it('loads only trust and private-key paths for signing, without database credentials', () => {
    expect(
      loadAppConfigSigningEnvironment(
        {
          APP_CONFIG_TRUST_FILE: '/var/lib/operator/trust.json',
          APP_CONFIG_SIGNING_KEY_FILE: '/var/lib/operator/signer.pem',
        },
        '/work/base-app',
      ),
    ).toEqual({
      trustFile: '/var/lib/operator/trust.json',
      signingKeyFile: '/var/lib/operator/signer.pem',
    });
  });

  it('rejects approval files with broad permissions and accepts private external files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'app-config-operator-'));
    try {
      await chmod(directory, 0o700);
      const file = join(directory, 'signer.pem');
      await writeFile(file, 'test-only-private-key', { mode: 0o644 });
      await expect(readProtectedFile(file, resolve('/work/base-app'), 1024)).rejects.toThrow(
        /mode 0600/,
      );
      await chmod(file, 0o600);
      await expect(readProtectedFile(file, resolve('/work/base-app'), 1024)).resolves.toEqual(
        Buffer.from('test-only-private-key'),
      );
      await expect(
        readProtectedFile(
          join(resolve('/work/base-app'), 'signer.pem'),
          resolve('/work/base-app'),
          1024,
        ),
      ).rejects.toThrow(/outside the checkout/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects postgres login and URL SSL overrides before connection setup', () => {
    expect(() =>
      parseAppConfigDatabaseTarget(
        'postgresql://postgres:pw@db.example.invalid/postgres',
        'invalid',
      ),
    ).toThrow(/dedicated login/);
    expect(() =>
      parseAppConfigDatabaseTarget(
        'postgresql://app_config:pw@db.example.invalid/postgres?sslmode=require',
        'invalid',
      ),
    ).toThrow(/query parameters are not allowed/);
  });

  it('rejects destination, dirty checkout, and changed commit before any database work', async () => {
    const { envelope, trust } = await signedEnvelope();
    const port = fakePort();
    expect(() =>
      assertAppConfigApprovalContext({
        payload: envelope.payload,
        target: { ...TARGET, host: 'other.example.invalid' },
        checkout: CHECKOUT,
        now: NOW,
      }),
    ).toThrow(/different admin database/);
    expect(() =>
      assertAppConfigApprovalContext({
        payload: envelope.payload,
        target: TARGET,
        checkout: { ...CHECKOUT, clean: false },
        now: NOW,
      }),
    ).toThrow(/checkout must be clean/);
    expect(() =>
      assertAppConfigApprovalContext({
        payload: envelope.payload,
        target: TARGET,
        checkout: { ...CHECKOUT, commit: 'd'.repeat(40) },
        now: NOW,
      }),
    ).toThrow(/different clean commit/);
    await expect(
      executeApprovedAppConfigPlan({
        envelope,
        trustRegistry: trust,
        port: port.port,
        target: { ...TARGET, database: 'other_db' },
        checkout: CHECKOUT,
        now: NOW,
      }),
    ).rejects.toThrow(/different admin database/);
    expect(port.reads).toEqual([]);
    expect(port.writes).toEqual([]);
  });

  it('rejects expired and future-prepared plans before mutation', async () => {
    const { envelope, trust } = await signedEnvelope();
    const port = fakePort();
    await expect(
      executeApprovedAppConfigPlan({
        envelope,
        trustRegistry: trust,
        port: port.port,
        target: TARGET,
        checkout: CHECKOUT,
        now: new Date('2026-11-25T12:16:00.000Z'),
      }),
    ).rejects.toThrow(/expired/);
    const future = await signedEnvelope(setPlan(), new Date('2026-11-25T12:01:00.000Z'));
    await expect(
      executeApprovedAppConfigPlan({
        envelope: future.envelope,
        trustRegistry: future.trust,
        port: port.port,
        target: TARGET,
        checkout: CHECKOUT,
        now: NOW,
      }),
    ).rejects.toThrow(/prepared in the future/);
    expect(port.writes).toEqual([]);
  });
});

describe('app-config approval execution boundary', () => {
  it('compares fresh CAS state before one setter call and binds plan id plus payload digest', async () => {
    const { envelope, trust } = await signedEnvelope();
    const fake = fakePort();
    const receipt = await executeApprovedAppConfigPlan({
      envelope,
      trustRegistry: trust,
      port: fake.port,
      target: TARGET,
      checkout: CHECKOUT,
      now: NOW,
    });
    expect(fake.reads).toEqual(['current:legal']);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]).toMatchObject({
      key: 'legal',
      value: NEW_LEGAL,
      expectedUpdatedAt: UPDATED_AT,
      force: false,
      actorRef: `script:app-config:${envelope.payload.planId}`,
      correlationId: envelope.payloadSha256,
    });
    expect(receipt).toEqual({
      planId: envelope.payload.planId,
      payloadSha256: envelope.payloadSha256,
    });
  });

  it('rejects stale CAS snapshots and maps SQL AC409 without retrying the setter', async () => {
    const { envelope, trust } = await signedEnvelope();
    const stale = fakePort({
      current: { value: OLD_LEGAL, updatedAt: '2026-11-25 12:34:56.000001+00' },
    });
    await expect(
      executeApprovedAppConfigPlan({
        envelope,
        trustRegistry: trust,
        port: stale.port,
        target: TARGET,
        checkout: CHECKOUT,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'app_config.conflict' });
    expect(stale.writes).toHaveLength(0);

    const sqlConflict = fakePort({ writeError: { code: 'AC409', message: 'private SQL detail' } });
    await expect(
      executeApprovedAppConfigPlan({
        envelope,
        trustRegistry: trust,
        port: sqlConflict.port,
        target: TARGET,
        checkout: CHECKOUT,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'app_config.conflict' });
    expect(sqlConflict.writes).toHaveLength(1);
  });

  it('rechecks expiry and checkout immediately before the single mutator call', async () => {
    const { envelope, trust } = await signedEnvelope();
    const expiredDuringReads = fakePort();
    await expect(
      executeApprovedAppConfigPlan({
        envelope,
        trustRegistry: trust,
        port: expiredDuringReads.port,
        target: TARGET,
        checkout: CHECKOUT,
        now: NOW,
        clock: () => new Date('2026-11-25T12:16:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'app_config.plan_expired' });
    expect(expiredDuringReads.writes).toHaveLength(0);

    const dirtyDuringReads = fakePort();
    await expect(
      executeApprovedAppConfigPlan({
        envelope,
        trustRegistry: trust,
        port: dirtyDuringReads.port,
        target: TARGET,
        checkout: CHECKOUT,
        now: NOW,
        refreshContext: () => ({ target: TARGET, checkout: { ...CHECKOUT, clean: false } }),
      }),
    ).rejects.toMatchObject({ code: 'app_config.checkout_dirty' });
    expect(dirtyDuringReads.writes).toHaveLength(0);
  });

  it('re-reads the exact latest rollback event before writing once', async () => {
    const source = {
      eventId: ROLLBACK_EVENT_ID,
      key: 'legal' as const,
      before: OLD_LEGAL,
      after: NEW_LEGAL,
    };
    const rollback = planRollback({
      key: 'legal',
      current: { value: NEW_LEGAL, updatedAt: UPDATED_AT },
      source,
    });
    const { envelope, trust } = await signedEnvelope(rollback);
    const fake = fakePort({
      current: { value: NEW_LEGAL, updatedAt: UPDATED_AT },
      rollback: source,
    });
    await executeApprovedAppConfigPlan({
      envelope,
      trustRegistry: trust,
      port: fake.port,
      target: TARGET,
      checkout: CHECKOUT,
      now: NOW,
    });
    expect(fake.reads).toEqual(['current:legal', 'rollback:legal']);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]).toMatchObject({ value: OLD_LEGAL, force: false });

    const changedSource = fakePort({
      current: { value: NEW_LEGAL, updatedAt: UPDATED_AT },
      rollback: { ...source, eventId: '8c26fdb6-c767-4c99-9263-a75df9a23be0' },
    });
    await expect(
      executeApprovedAppConfigPlan({
        envelope,
        trustRegistry: trust,
        port: changedSource.port,
        target: TARGET,
        checkout: CHECKOUT,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'app_config.rollback_conflict' });
    expect(changedSource.writes).toHaveLength(0);
  });
});

describe('app-config PostgreSQL adapter', () => {
  function fakeSqlPool(
    results: readonly Record<string, unknown>[][] = [],
    options: {
      readonly roleOverrides?: Readonly<Record<string, unknown>>;
      readonly memberships?: readonly string[];
    } = {},
  ) {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    let resultIndex = 0;
    const pool: AppConfigSqlPool = {
      async connect() {
        return {
          async query(text: string, values: unknown[] = []) {
            calls.push({ text, values });
            if (text.includes('from pg_catalog.pg_roles as role_info')) {
              return {
                rows: [
                  {
                    login_name: 'app_config_operator',
                    rolcanlogin: true,
                    rolsuper: false,
                    rolbypassrls: false,
                    rolcreaterole: false,
                    rolcreatedb: false,
                    rolreplication: false,
                    can_set_writer: true,
                    ...options.roleOverrides,
                  },
                ],
                rowCount: 1,
              };
            }
            if (text.includes('from pg_catalog.pg_roles as member_role')) {
              const memberships = options.memberships ?? ['app_config_writer'];
              return {
                rows: memberships.map((role_name) => ({ role_name })),
                rowCount: memberships.length,
              };
            }
            const rows = results[resultIndex] ?? [];
            if (text.includes('read_setting(') || text.includes('read_rollback_setting('))
              resultIndex += 1;
            return { rows, rowCount: rows.length };
          },
          release() {},
        };
      },
      async end() {},
    };
    return { pool, calls };
  }

  it('reads through the restricted functions and preserves timestamp microseconds as text', async () => {
    const { pool, calls } = fakeSqlPool([
      [{ value: OLD_LEGAL, updated_at: UPDATED_AT }],
      [
        {
          event_id: ROLLBACK_EVENT_ID,
          before_value: OLD_LEGAL,
          after_value: NEW_LEGAL,
          occurred_at: UPDATED_AT,
        },
      ],
    ]);
    const adapter = createPostgresAppConfigAdapter(pool, 'app_config_operator');
    const snapshot = await adapter.readCurrent('legal');
    const rollback = await adapter.readLatestRollbackSource('legal');
    expect(snapshot).toEqual({ value: OLD_LEGAL, updatedAt: UPDATED_AT });
    expect(rollback).toEqual({
      eventId: ROLLBACK_EVENT_ID,
      key: 'legal',
      before: OLD_LEGAL,
      after: NEW_LEGAL,
    });
    expect(calls.filter((call) => call.text.includes('set_config'))).toEqual([
      { text: "select pg_catalog.set_config('role', $1, true)", values: ['app_config_writer'] },
      { text: "select pg_catalog.set_config('role', $1, true)", values: ['app_config_writer'] },
    ]);
    expect(calls.some((call) => call.text.includes('from app_config.settings'))).toBe(false);
    expect(calls.some((call) => call.text.includes('from audit.events'))).toBe(false);
    expect(
      calls.filter((call) => call.text.includes('from pg_catalog.pg_roles as role_info')),
    ).toHaveLength(2);
    expect(
      calls.filter((call) => call.text.includes('from pg_catalog.pg_roles as member_role')),
    ).toHaveLength(2);
    expect(calls.findIndex((call) => call.text.includes('role_info.rolname'))).toBeLessThan(
      calls.findIndex((call) => call.text.includes('set_config')),
    );
    expect(
      calls.map((call) => call.text).filter((text) => text.includes('app_config.read_')),
    ).toEqual([
      'select value, updated_at::text as updated_at from app_config.read_setting($1::text)',
      'select event_id::text as event_id, before_value, after_value, occurred_at::text as occurred_at from app_config.read_rollback_setting($1::text)',
    ]);
  });

  it('calls only the seven-argument setter with a transaction-local writer role and no retry', async () => {
    const { pool, calls } = fakeSqlPool();
    const adapter = createPostgresAppConfigAdapter(pool, 'app_config_operator');
    await adapter.writeSetting({
      key: 'legal',
      value: NEW_LEGAL,
      expectedUpdatedAt: UPDATED_AT,
      force: true,
      actorRef: 'script:app-config:5a10e8fe-1285-4c3b-9c62-2f0c58cc01b4',
      correlationId: 'f'.repeat(64),
    });
    const setterCalls = calls.filter((call) => call.text.includes('app_config.set_setting'));
    expect(setterCalls).toHaveLength(1);
    expect(setterCalls[0]).toEqual({
      text: 'select app_config.set_setting($1::text, $2::jsonb, $3::text, $4::text, $5::text, $6::timestamptz, $7::boolean)',
      values: [
        'legal',
        JSON.stringify(NEW_LEGAL),
        'system',
        'script:app-config:5a10e8fe-1285-4c3b-9c62-2f0c58cc01b4',
        'f'.repeat(64),
        UPDATED_AT,
        true,
      ],
    });
    expect(calls.find((call) => call.text.includes('set_config'))).toEqual({
      text: "select pg_catalog.set_config('role', $1, true)",
      values: ['app_config_writer'],
    });
    expect(
      calls.some((call) =>
        /\b(insert|update|delete)\s+into?\s+app_config\.settings/i.test(call.text),
      ),
    ).toBe(false);
  });

  it('pins every connection destination field explicitly so PGPORT cannot change the signed target', () => {
    const environment: AppConfigOperatorEnvironment = {
      database: {
        host: TARGET.host,
        port: TARGET.port,
        database: TARGET.database,
        user: TARGET.username,
        password: 'test-only-password',
      },
      databaseCaCertificate: 'test-only-ca',
      target: TARGET,
      trustFile: '/tmp/trust.json',
    };
    const originalPgPort = process.env.PGPORT;
    process.env.PGPORT = '6543';
    try {
      const config = createAppConfigAdminPoolConfig(environment);
      expect(config).toMatchObject({
        host: TARGET.host,
        port: TARGET.port,
        database: TARGET.database,
        user: TARGET.username,
        password: 'test-only-password',
        application_name: 'base-app-app-config-operator',
        options: '-c statement_timeout=10000',
        ssl: { ca: 'test-only-ca', rejectUnauthorized: true },
      });
      expect(config.connectionString).toBeUndefined();
    } finally {
      if (originalPgPort === undefined) delete process.env.PGPORT;
      else process.env.PGPORT = originalPgPort;
    }
  });

  it('refuses elevated or over-membered logins before app-config reads or writes', async () => {
    for (const roleOverrides of [{ rolsuper: true }, { rolbypassrls: true }]) {
      const elevated = fakeSqlPool([], { roleOverrides });
      const adapter = createPostgresAppConfigAdapter(elevated.pool, 'app_config_operator');
      await expect(adapter.readCurrent('legal')).rejects.toMatchObject({
        code: 'app_config.login_scope',
      });
      expect(elevated.calls.some((call) => call.text.includes('app_config.read_setting'))).toBe(
        false,
      );
    }

    const overMembered = fakeSqlPool([], {
      memberships: ['app_config_writer', 'app_config_admin'],
    });
    const secondAdapter = createPostgresAppConfigAdapter(overMembered.pool, 'app_config_operator');
    await expect(
      secondAdapter.writeSetting({
        key: 'legal',
        value: NEW_LEGAL,
        expectedUpdatedAt: UPDATED_AT,
        force: false,
        actorRef: 'script:app-config:5a10e8fe-1285-4c3b-9c62-2f0c58cc01b4',
        correlationId: 'f'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'app_config.login_scope' });
    expect(overMembered.calls.some((call) => call.text.includes('app_config.set_setting'))).toBe(
      false,
    );
  });
});
