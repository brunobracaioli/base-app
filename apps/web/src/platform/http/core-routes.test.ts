import { describe, expect, it } from 'vitest';
import { AppConfigResponse } from '@base-app/contracts';
import type { Pool } from 'pg';

import { ConsentRecord } from '../../modules/privacy';
import type { ConsentRepository, LegalVersionsReader } from '../../modules/privacy';
import { createPrivacyUseCases } from '../../modules/privacy';
import {
  createIdentityUseCases,
  createProfileRepository,
  UserProfile,
} from '../../modules/identity';
import type { ProfileRepository } from '../../modules/identity';
import type { CoreComposition } from '../composition/core';
import { createDatabaseRuntime } from '../db/runtime';
import type { AppLogger } from '../observability/logger';
import type { DatabaseEnvironment } from '../env';
import {
  createTestRouteDependencies,
  createTestUserAuthContext,
  TEST_USER_A,
  TEST_USER_B,
} from '../testing/route-dependencies';
import { createDefineRoute } from './define-route';
import { createCoreRouteDefinitions } from './core-routes';

const NOW = new Date('2026-11-25T12:00:00.000Z');
const LEGAL_VERSIONS = { termsVersion: '2026-11-24', privacyVersion: '2026-11-25' } as const;
const APP_CONFIG_RESPONSE = AppConfigResponse.parse({
  versions: {
    ios: {
      minSupported: '1.0.0',
      latest: '1.1.0',
      storeUrl: 'https://apps.apple.com/app/id0000000000',
    },
    android: {
      minSupported: '1.0.0',
      latest: '1.1.0',
      storeUrl: 'https://play.google.com/store/apps/details?id=com.example.myapp',
    },
  },
  maintenance: {
    active: false,
    platforms: ['ios', 'android'],
    messageKey: 'maintenance.default',
    until: null,
  },
  legal: {
    termsVersion: '2026-01-01',
    privacyVersion: '2026-01-01',
    termsUrl: 'https://myapp.example.invalid/terms',
    privacyUrl: 'https://myapp.example.invalid/privacy',
  },
});
const DATABASE_ENVIRONMENT: DatabaseEnvironment = {
  DATABASE_URL: 'postgresql://api_runtime:secret@db.example.invalid:6543/postgres',
  DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nlocal-test-ca\n-----END CERTIFICATE-----',
};

type SqlCall = { readonly text: string; readonly values: readonly unknown[] };
type FakeQuery = string | { readonly text: string; readonly values?: readonly unknown[] };

type FakeCoreState = {
  readonly runtime: CoreComposition;
  readonly profiles: Map<string, UserProfile>;
  readonly creationCount: Map<string, number>;
  readonly consents: Map<string, ConsentRecord>;
  readonly acceptedWrites: { userId: string; acceptedAt: Date }[];
  readonly correlationIds: string[];
};

function consentKey(record: Pick<ConsentRecord, 'userId' | 'document' | 'version'>): string {
  return `${record.userId}:${record.document}:${record.version}`;
}

function createFakeCoreState(): FakeCoreState {
  const profiles = new Map<string, UserProfile>();
  const creationCount = new Map<string, number>();
  const consents = new Map<string, ConsentRecord>();
  const acceptedWrites: { userId: string; acceptedAt: Date }[] = [];
  const correlationIds: string[] = [];
  const profileRepository: ProfileRepository = {
    async ensureProfile(input) {
      const existing = profiles.get(input.userId);
      if (existing) return existing;
      const profile = UserProfile.restore(
        {
          userId: input.userId,
          displayName: null,
          locale: input.initialLocale,
          createdAt: NOW,
        },
        ['pt-BR', 'en', 'es'],
      );
      profiles.set(input.userId, profile);
      creationCount.set(input.userId, (creationCount.get(input.userId) ?? 0) + 1);
      return profile;
    },
    async updateProfile(input) {
      const current = profiles.get(input.userId);
      if (!current) throw new Error('Profile must be created before update.');
      const updated = current.update(input.changes).profile;
      profiles.set(input.userId, updated);
      return updated;
    },
  };
  const consentRepository: ConsentRepository = {
    async listForUser(userId) {
      return [...consents.values()].filter((record) => record.userId === userId);
    },
    async accept(record) {
      const key = consentKey(record);
      if (consents.has(key)) return;
      consents.set(key, record);
      acceptedWrites.push({ userId: record.userId, acceptedAt: record.acceptedAt });
    },
  };
  const legalVersions: LegalVersionsReader = {
    async readCurrent() {
      return LEGAL_VERSIONS;
    },
  };
  const privacy = createPrivacyUseCases({
    consents: consentRepository,
    legalVersions,
    clock: { now: () => new Date(NOW.getTime()) },
  });
  const identity = createIdentityUseCases({
    profiles: profileRepository,
    consentStatus: { getStatus: privacy.getConsentStatus },
    supportedLocales: ['pt-BR', 'en', 'es'],
    defaultLocale: 'pt-BR',
  });
  const runtime: CoreComposition = {
    async getMe(request) {
      correlationIds.push(request.correlationId);
      if (request.auth.userId !== request.auth.dbClaims.sub)
        throw new Error('Mismatched user scope.');
      return identity.getMe({
        userId: request.auth.dbClaims.sub,
        email: request.auth.email,
        profileLocaleHint: request.profileLocaleHint,
      });
    },
    async updateMe(request) {
      correlationIds.push(request.correlationId);
      if (request.auth.userId !== request.auth.dbClaims.sub)
        throw new Error('Mismatched user scope.');
      return identity.updateProfile({
        userId: request.auth.dbClaims.sub,
        email: request.auth.email,
        profileLocaleHint: request.profileLocaleHint,
        patch: request.patch,
      });
    },
    async acceptConsent(request) {
      correlationIds.push(request.correlationId);
      if (request.auth.userId !== request.auth.dbClaims.sub)
        throw new Error('Mismatched user scope.');
      await privacy.acceptConsent({
        userId: request.auth.dbClaims.sub,
        document: request.document,
        version: request.version,
      });
    },
    async loadFreshRoles() {
      return [];
    },
    async getPublicAppConfig() {
      return APP_CONFIG_RESPONSE;
    },
    async checkAppConfigGate() {
      return { allow: true };
    },
  };
  return { runtime, profiles, creationCount, consents, acceptedWrites, correlationIds };
}

function protectedRoutes(state: FakeCoreState) {
  const definitions = createCoreRouteDefinitions(() => state.runtime);
  const test = createTestRouteDependencies({
    users: { tokenA: TEST_USER_A, tokenB: TEST_USER_B },
    overrides: {
      async authenticateUser(token) {
        return {
          ok: true,
          value: createTestUserAuthContext(token === 'tokenB' ? TEST_USER_B : TEST_USER_A),
        };
      },
    },
  });
  const defineRoute = createDefineRoute(test.dependencies);
  return {
    state,
    test,
    getMe: defineRoute(definitions.getMe),
    updateMe: defineRoute(definitions.updateMe),
    acceptConsent: defineRoute(definitions.acceptConsent),
  };
}

function request(path: string, method: string, token: string, body?: unknown): Request {
  return new Request(`https://app.example/api/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-real-ip': '198.51.100.12',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function createForeignKeyFailureDatabase() {
  const calls: SqlCall[] = [];
  const foreignKeyError = Object.assign(new Error('auth.users foreign key does not exist'), {
    code: '23503',
  });
  const client = {
    async query(query: FakeQuery, values?: readonly unknown[]) {
      const text = typeof query === 'string' ? query : query.text;
      const parameters = values ?? (typeof query === 'string' ? [] : (query.values ?? []));
      calls.push({ text, values: parameters });
      if (text.toLowerCase().startsWith('insert into "identity"."profiles"')) {
        throw foreignKeyError;
      }
      return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
    on() {},
    async end() {},
  } as unknown as Pool;
  const logger: AppLogger = { info() {}, warn() {}, error() {} };
  const database = createDatabaseRuntime(
    DATABASE_ENVIRONMENT,
    { extensionSystemRoles: [], logger },
    { createPool: () => pool, attachDatabasePool() {} },
  );
  return { database, calls };
}

describe('W4 core endpoint definitions', () => {
  it('serves app config publicly with query-independent cached content', async () => {
    const state = createFakeCoreState();
    let configReads = 0;
    const definition = createCoreRouteDefinitions(
      () => state.runtime,
      async () => {
        configReads += 1;
        return APP_CONFIG_RESPONSE;
      },
    ).getAppConfig;
    const test = createTestRouteDependencies();
    const route = createDefineRoute(test.dependencies)(definition);
    const first = await route(
      new Request('https://app.example/api/v1/app-config?client=ios', {
        headers: { 'x-real-ip': '198.51.100.12' },
      }),
    );
    const second = await route(
      new Request('https://app.example/api/v1/app-config?client=android', {
        headers: { 'x-real-ip': '198.51.100.12' },
      }),
    );

    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe(
      'public, s-maxage=60, stale-while-revalidate=60',
    );
    expect(await first.json()).toEqual(await second.json());
    expect(configReads).toBe(2);
    expect(test.rateLimiter.calls.map(({ bucket }) => bucket)).toEqual([
      'getAppConfig:ip:198.51.100.12',
      'getAppConfig:ip:198.51.100.12',
    ]);
  });
  it('isolates GET and PATCH by the verified JWT subject', async () => {
    const routes = protectedRoutes(createFakeCoreState());
    const a = await routes.getMe(request('me', 'GET', 'tokenA'));
    const b = await routes.getMe(request('me', 'GET', 'tokenB'));

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await a.json()).id).toBe(TEST_USER_A);
    expect((await b.json()).id).toBe(TEST_USER_B);

    const updatedA = await routes.updateMe(
      request('me', 'PATCH', 'tokenA', { displayName: 'Ana' }),
    );
    expect(updatedA.status).toBe(200);
    expect((await routes.getMe(request('me', 'GET', 'tokenB'))).status).toBe(200);
    expect(routes.state.profiles.get(TEST_USER_B)?.displayName).toBeNull();
    expect(routes.state.profiles.get(TEST_USER_A)?.displayName).toBe('Ana');
    expect(routes.state.correlationIds).toEqual([
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    ]);
  });

  it('rejects unknown PATCH properties before invoking the use case', async () => {
    const routes = protectedRoutes(createFakeCoreState());
    const response = await routes.updateMe(
      request('me', 'PATCH', 'tokenA', { displayName: 'Ana', userId: TEST_USER_B }),
    );

    expect(response.status).toBe(400);
    expect(routes.state.profiles.size).toBe(0);
    expect(await response.json()).toMatchObject({ code: 'validation.failed' });
  });

  it('normalizes PATCH names and does not persist absent fields', async () => {
    const routes = protectedRoutes(createFakeCoreState());
    const response = await routes.updateMe(
      request('me', 'PATCH', 'tokenA', { displayName: '  Cafe\u0301\u0000  ' }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).displayName).toBe('Café');
    expect(routes.state.profiles.get(TEST_USER_A)?.locale).toBe('pt-BR');
  });

  it('rejects a name that becomes empty after controls are removed', async () => {
    const routes = protectedRoutes(createFakeCoreState());
    const response = await routes.updateMe(
      request('me', 'PATCH', 'tokenA', { displayName: ' \u0000 ' }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('validation.failed');
    expect(routes.state.profiles.get(TEST_USER_A)?.displayName).toBeNull();
  });

  it.each([
    [
      'unknown fields',
      { document: 'terms', version: LEGAL_VERSIONS.termsVersion, userId: TEST_USER_B },
    ],
    ['malformed version', { document: 'terms', version: 'not-a-date' }],
  ] as const)('rejects consent payloads with %s as validation.failed', async (_case, body) => {
    const routes = protectedRoutes(createFakeCoreState());
    const response = await routes.acceptConsent(request('me/consents', 'POST', 'tokenA', body));

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('validation.failed');
    expect(routes.state.acceptedWrites).toHaveLength(0);
  });

  it('returns exactly an empty 204 on first and repeated consent acceptance', async () => {
    const routes = protectedRoutes(createFakeCoreState());
    const accept = () =>
      routes.acceptConsent(
        request('me/consents', 'POST', 'tokenA', {
          document: 'privacy',
          version: LEGAL_VERSIONS.privacyVersion,
        }),
      );

    const first = await accept();
    const firstAcceptedAt = routes.state.acceptedWrites[0]?.acceptedAt;
    const second = await accept();

    expect(first.status).toBe(204);
    expect(await first.text()).toBe('');
    expect(second.status).toBe(204);
    expect(await second.text()).toBe('');
    expect(routes.state.acceptedWrites).toHaveLength(1);
    expect(routes.state.acceptedWrites[0]?.acceptedAt).toBe(firstAcceptedAt);
  });

  it('rejects an outdated consent version without inserting a record', async () => {
    const routes = protectedRoutes(createFakeCoreState());
    const response = await routes.acceptConsent(
      request('me/consents', 'POST', 'tokenA', {
        document: 'terms',
        version: '2026-11-23',
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'privacy.consent_version_outdated' });
    expect(routes.state.acceptedWrites).toHaveLength(0);
  });

  it('creates only one profile when the first GETs race', async () => {
    const routes = protectedRoutes(createFakeCoreState());
    const [first, second] = await Promise.all([
      routes.getMe(request('me', 'GET', 'tokenA')),
      routes.getMe(request('me', 'GET', 'tokenA')),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(routes.state.creationCount.get(TEST_USER_A)).toBe(1);
    expect(routes.state.profiles.size).toBe(1);
  });

  it('maps a profile foreign-key violation to auth.account_deleted without exposing database details', async () => {
    const { database, calls } = createForeignKeyFailureDatabase();
    const runtime: CoreComposition = {
      async getMe({ auth }) {
        const profiles = createProfileRepository({
          database,
          dbClaims: auth.dbClaims,
          supportedLocales: ['pt-BR', 'en', 'es'],
        });
        await profiles.ensureProfile({ userId: auth.dbClaims.sub, initialLocale: 'pt-BR' });
        throw new Error('unreachable after failed profile insert');
      },
      async updateMe() {
        throw new Error('not used in this test');
      },
      async acceptConsent() {
        throw new Error('not used in this test');
      },
      async loadFreshRoles() {
        return [];
      },
      async getPublicAppConfig() {
        return APP_CONFIG_RESPONSE;
      },
      async checkAppConfigGate() {
        return { allow: true };
      },
    };
    const dependencies = createTestRouteDependencies({
      overrides: {
        async authenticateUser() {
          return { ok: true, value: createTestUserAuthContext(TEST_USER_A) };
        },
      },
    });
    const route = createDefineRoute(dependencies.dependencies)(
      createCoreRouteDefinitions(() => runtime).getMe,
    );

    try {
      const response = await route(request('me', 'GET', 'tokenA'));
      const body = await response.text();
      expect(response.status).toBe(401);
      expect(JSON.parse(body)).toMatchObject({ code: 'auth.account_deleted' });
      expect(body).not.toContain('auth.users');
      expect(body).not.toContain('23503');
      const insert = calls.find((call) => call.text.toLowerCase().startsWith('insert into'));
      expect(insert?.values).toEqual([TEST_USER_A, 'pt-BR']);
    } finally {
      await database.destroy();
    }
  });
});
