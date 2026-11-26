import { parse } from 'yaml';
import { ZodError } from 'zod';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  buildOpenApiDocument,
  coreEndpoints,
  extensionEndpoints,
  generateOpenApiYaml,
  HealthResponseSchema,
  AppConfigResponse,
  LegalSetting,
  MaintenanceSetting,
  Platform,
  SemVer,
  VersionsSetting,
  ConsentBody,
  Locale,
  Me,
  ProblemDetailsSchema,
  UpdateProfileBody,
} from './index.js';

describe('base API contracts', () => {
  it('validates the minimal health response and rejects additional fields', () => {
    expect(HealthResponseSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
    expect(() => HealthResponseSchema.parse({ status: 'degraded' })).toThrow(ZodError);
    expect(() => HealthResponseSchema.parse({ status: 'ok', commit: 'abc' })).toThrow(ZodError);
  });

  it('validates RFC 9457 problem details with the stable code and request ID', () => {
    const problem = {
      type: 'https://example.invalid/problems/billing.entitlement_required',
      title: 'Entitlement required',
      status: 402,
      code: 'billing.entitlement_required',
      requestId: '0192f8a0-6b1c-7e5d-9a30-2b4c6d8e0f11',
      entitlement: 'pro',
    };

    expect(ProblemDetailsSchema.parse(problem)).toEqual(problem);
    expect(() => ProblemDetailsSchema.parse({ ...problem, requestId: 'not-a-uuid' })).toThrow(
      ZodError,
    );
    expect(() => ProblemDetailsSchema.parse({ ...problem, status: 600 })).toThrow(ZodError);
    expect(() => ProblemDetailsSchema.parse({ ...problem, stack: 'Error: internal' })).toThrow(
      ZodError,
    );
    expect(() =>
      ProblemDetailsSchema.parse({ ...problem, debug: 'database connection failed' }),
    ).toThrow(ZodError);
  });

  it('keeps the endpoint catalog public and the extension catalog empty', () => {
    expect(extensionEndpoints).toEqual([]);
    expect(coreEndpoints.map(({ method, path }) => `${method.toUpperCase()} ${path}`)).toEqual([
      'GET /v1/health',
      'GET /v1/app-config',
      'GET /v1/me',
      'PATCH /v1/me',
      'POST /v1/me/consents',
    ]);
    expect(
      coreEndpoints
        .filter((endpoint) => endpoint.security.length === 0)
        .map(({ method, path }) => `${method.toUpperCase()} ${path}`),
    ).toEqual(['GET /v1/health', 'GET /v1/app-config']);
    expect(
      coreEndpoints
        .filter((endpoint) => endpoint.path === '/v1/me')
        .every((endpoint) => endpoint.security.length > 0),
    ).toBe(true);
  });

  it('declares health rate-limit metadata and emits an OpenAPI 3.1 public operation', () => {
    const endpoint = coreEndpoints[0];
    expect(endpoint).toBeDefined();
    if (endpoint === undefined) return;

    expect(endpoint.rateLimit).toEqual({
      key: 'ip',
      limit: 60,
      windowSec: 60,
      ipLimit: 60,
      onStoreFailure: 'open',
    });

    const document = buildOpenApiDocument();
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.version).toBe('1.2.0');
    expect(document.info.description).toMatch(/Compatible additive revision/);
    expect(document.paths['/v1/health']?.get?.security).toEqual([]);
    expect(document.paths['/v1/health']?.get?.['x-rate-limit-ip-limit']).toBe(60);
    expect(document.paths['/v1/health']?.get?.['x-rate-limit-failure']).toBe('open');
    expect(document.components.schemas.HealthResponse?.additionalProperties).toBe(false);
    expect(document.components.schemas.ProblemDetails?.additionalProperties).toBe(false);
    expect(document.components.schemas.HealthResponse?.$schema).toBeUndefined();
  });

  it('generates stable YAML that parses back to the same OpenAPI document', () => {
    const first = generateOpenApiYaml();
    const second = generateOpenApiYaml();

    expect(first).toBe(second);
    expect(parse(first)).toEqual(buildOpenApiDocument());
  });

  it('validates strict profile and consent schemas using product locales', () => {
    const me = {
      id: '6f0e1c2a-8b6d-4f0a-9d63-0c5c9f1a2b3c',
      email: 'user@example.com',
      displayName: 'Ana',
      locale: Locale.options[0],
      createdAt: '2026-11-24T12:00:00Z',
      consents: { needsAcceptance: ['terms'] },
    };
    expect(Me.parse(me)).toEqual(me);
    expect(() => Me.parse({ ...me, unknown: true })).toThrow(ZodError);
    expect(() => Me.parse({ ...me, locale: 'fr' })).toThrow(ZodError);

    expect(UpdateProfileBody.parse({ displayName: ' Ana ' })).toEqual({ displayName: 'Ana' });
    expect(UpdateProfileBody.parse({ locale: Locale.options[0] })).toEqual({
      locale: Locale.options[0],
    });
    expect(() => UpdateProfileBody.parse({})).toThrow(ZodError);
    expect(() => UpdateProfileBody.parse({ displayName: '   ' })).toThrow(ZodError);
    expect(() => UpdateProfileBody.parse({ displayName: 'Ana', userId: me.id })).toThrow(ZodError);

    const consent = { document: 'terms', version: '2026-11-24' };
    expect(ConsentBody.parse(consent)).toEqual(consent);
    expect(() => ConsentBody.parse({ ...consent, extra: true })).toThrow(ZodError);
    expect(() => ConsentBody.parse({ ...consent, version: '2026-2-4' })).toThrow(ZodError);
  });

  it('declares authenticated user limits and OpenAPI request/problem responses', () => {
    const getMe = coreEndpoints.find(({ operationId }) => operationId === 'getMe');
    const updateMe = coreEndpoints.find(({ operationId }) => operationId === 'updateMe');
    const acceptConsent = coreEndpoints.find(({ operationId }) => operationId === 'acceptConsent');
    expect(getMe?.rateLimit).toEqual({
      key: 'user',
      limit: 60,
      windowSec: 60,
      ipLimit: 120,
      onStoreFailure: 'closed',
    });
    expect(updateMe?.rateLimit).toEqual({
      key: 'user',
      limit: 20,
      windowSec: 60,
      ipLimit: 120,
      onStoreFailure: 'closed',
    });
    expect(acceptConsent?.rateLimit).toEqual({
      key: 'user',
      limit: 20,
      windowSec: 3_600,
      ipLimit: 120,
      onStoreFailure: 'closed',
    });

    const document = buildOpenApiDocument();
    const patch = document.paths['/v1/me']?.patch;
    expect(patch?.requestBody).toMatchObject({
      required: true,
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/UpdateProfileBody' } },
      },
    });
    expect(document.components.schemas.UpdateProfileBody?.additionalProperties).toBe(false);

    const consent = document.paths['/v1/me/consents']?.post;
    expect(consent?.requestBody).toMatchObject({
      required: true,
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/ConsentBody' } },
      },
    });
    expect(consent?.responses['204']).toEqual({
      description: 'The consent was accepted or had already been accepted.',
    });
    expect(consent?.responses['409']?.description).toMatch(/no longer current/);
    for (const status of ['400', '401', '409', '429', '503']) {
      expect(consent?.responses[status]?.content?.['application/problem+json']?.schema).toEqual({
        $ref: '#/components/schemas/ProblemDetails',
      });
    }

    for (const endpoint of coreEndpoints.filter((candidate) => candidate.security.length > 0)) {
      const operation = document.paths[endpoint.path]?.[endpoint.method];
      expect(operation?.responses['426']?.content?.['application/problem+json']?.schema).toEqual({
        $ref: '#/components/schemas/ProblemDetails',
      });
      expect(operation?.responses['503']?.content?.['application/problem+json']?.schema).toEqual({
        $ref: '#/components/schemas/ProblemDetails',
      });
      expect(operation?.responses['503']?.headers?.['Retry-After']?.schema).toMatchObject({
        type: 'string',
        const: '60',
      });
    }
  });

  it('validates app configuration settings and preserves numeric version ordering without precision loss', () => {
    expect(SemVer.parse('1.10.0')).toBe('1.10.0');
    expect(Platform.parse('ios')).toBe('ios');
    expect(() => Platform.parse('web')).toThrow(ZodError);

    const validVersions = {
      ios: { minSupported: '1.9.0', latest: '1.10.0', published: '1.10.0' },
      android: { minSupported: '1.2.0', latest: '1.4.0' },
    };
    expect(VersionsSetting.parse(validVersions)).toEqual(validVersions);
    expect(() =>
      VersionsSetting.parse({
        ...validVersions,
        ios: { minSupported: '1.10.0', latest: '1.9.0' },
      }),
    ).toThrow(ZodError);
    expect(() => VersionsSetting.parse({ ...validVersions, unknown: true })).toThrow(ZodError);
    expect(() =>
      VersionsSetting.parse({ ...validVersions, ios: { ...validVersions.ios, unknown: true } }),
    ).toThrow(ZodError);

    const precisionSensitive = {
      ios: { minSupported: '1.9007199254740993.0', latest: '1.9007199254740992.999' },
      android: { minSupported: '1.0.0', latest: '1.0.0' },
    };
    expect(() => VersionsSetting.parse(precisionSensitive)).toThrow(ZodError);

    const largeComponent = '9'.repeat(400);
    const largeVersions = {
      ios: { minSupported: `1.${largeComponent}.0`, latest: `1.1${'0'.repeat(400)}.0` },
      android: { minSupported: '1.0.0', latest: '1.0.0' },
    };
    expect(VersionsSetting.parse(largeVersions)).toEqual(largeVersions);
  });

  it('normalizes strict maintenance settings and accepts only calendar-valid legal dates', () => {
    expect(MaintenanceSetting.parse({ active: false })).toEqual({
      active: false,
      platforms: ['ios', 'android'],
      messageKey: 'maintenance.default',
      until: null,
    });
    expect(() => MaintenanceSetting.parse({ active: false, unexpected: true })).toThrow(ZodError);
    expect(() => MaintenanceSetting.parse({ active: false, platforms: ['web'] })).toThrow(ZodError);
    expect(() =>
      MaintenanceSetting.parse({ active: false, platforms: ['ios'], nested: { unexpected: true } }),
    ).toThrow(ZodError);

    const legal = { termsVersion: '2024-02-29', privacyVersion: '2026-11-25' };
    expect(LegalSetting.parse(legal)).toEqual(legal);
    expect(() => LegalSetting.parse({ ...legal, termsVersion: '2025-02-29' })).toThrow(ZodError);
    expect(() => LegalSetting.parse({ ...legal, privacyVersion: '2026-04-31' })).toThrow(ZodError);
    expect(() => LegalSetting.parse({ ...legal, extra: true })).toThrow(ZodError);
  });

  it('declares the public app-config response, strict nested fields, and explicit cache header', () => {
    const appConfigEndpoint = coreEndpoints.find(
      ({ operationId }) => operationId === 'getAppConfig',
    );
    expect(appConfigEndpoint?.security).toEqual([]);
    expect(appConfigEndpoint?.rateLimit).toEqual({
      key: 'ip',
      limit: 60,
      windowSec: 60,
      ipLimit: 60,
      onStoreFailure: 'open',
    });

    const response = {
      versions: {
        ios: { minSupported: '1.2.0', latest: '1.4.0', storeUrl: 'https://apps.example/ios' },
        android: {
          minSupported: '1.2.0',
          latest: '1.4.0',
          storeUrl: 'https://apps.example/android',
        },
      },
      maintenance: {
        active: false,
        platforms: ['ios', 'android'],
        messageKey: 'maintenance.default',
        until: null,
      },
      legal: {
        termsVersion: '2026-11-24',
        privacyVersion: '2026-11-24',
        termsUrl: 'https://app.example/terms',
        privacyUrl: 'https://app.example/privacy',
      },
    };
    expect(AppConfigResponse.parse(response)).toEqual(response);
    expect(() =>
      AppConfigResponse.parse({
        ...response,
        versions: {
          ...response.versions,
          ios: { ...response.versions.ios, published: '1.4.0' },
        },
      }),
    ).toThrow(ZodError);
    expect(() =>
      AppConfigResponse.parse({
        ...response,
        versions: {
          ...response.versions,
          android: {
            ...response.versions.android,
            minSupported: '1.4.0',
            latest: '1.2.0',
          },
        },
      }),
    ).toThrow(ZodError);
    expect(() =>
      AppConfigResponse.parse({
        ...response,
        maintenance: { ...response.maintenance, extra: true },
      }),
    ).toThrow(ZodError);
    expect(() =>
      AppConfigResponse.parse({
        ...response,
        legal: { ...response.legal, termsVersion: '2026-02-30' },
      }),
    ).toThrow(ZodError);

    const document = buildOpenApiDocument();
    expect(document.info.version).toBe('1.2.0');
    expect(document.paths['/v1/app-config']?.get?.security).toEqual([]);
    expect(
      document.paths['/v1/app-config']?.get?.responses['200']?.headers?.['Cache-Control'],
    ).toEqual({
      description: 'Shared cache policy for remote app configuration.',
      schema: {
        type: 'string',
        const: 'public, s-maxage=60, stale-while-revalidate=60',
      },
    });
    expect(document.components.schemas.AppConfigResponse?.additionalProperties).toBe(false);
    expect(
      (
        document.components.schemas.AppConfigResponse?.properties as Record<
          string,
          { additionalProperties?: boolean }
        >
      ).versions?.additionalProperties,
    ).toBe(false);
  });

  it('registers schemas used by extension endpoints', () => {
    const extensionSchema = z.strictObject({ result: z.string() });
    const extensionEndpoint = {
      method: 'get',
      path: '/v1/example-extension/status',
      operationId: 'getExampleExtensionStatus',
      summary: 'Read extension status',
      security: [{ bearerAuth: [] }],
      rateLimit: {
        key: 'user',
        limit: 30,
        windowSec: 60,
        ipLimit: 120,
        onStoreFailure: 'closed',
      },
      successStatus: 200,
      successDescription: 'The extension status.',
      responseSchemaName: 'ExampleExtensionStatus',
      responseSchema: extensionSchema,
      rateLimitErrorStatuses: [429],
    } as const;

    const document = buildOpenApiDocument([...coreEndpoints, extensionEndpoint]);
    expect(document.components.schemas.ExampleExtensionStatus).toMatchObject({
      type: 'object',
      properties: { result: { type: 'string' } },
      additionalProperties: false,
    });
    expect(document.paths['/v1/example-extension/status']?.get?.security).toEqual([
      { bearerAuth: [] },
    ]);
  });

  it('rejects duplicate operations and conflicting response schema names', () => {
    const extensionSchema = z.strictObject({ result: z.string() });
    const extensionEndpoint = {
      method: 'get',
      path: '/v1/example-extension/status',
      operationId: 'getExampleExtensionStatus',
      summary: 'Read extension status',
      security: [],
      rateLimit: {
        key: 'ip',
        limit: 60,
        windowSec: 60,
        ipLimit: 60,
        onStoreFailure: 'open',
      },
      successStatus: 200,
      successDescription: 'The extension status.',
      responseSchemaName: 'ExampleExtensionStatus',
      responseSchema: extensionSchema,
      rateLimitErrorStatuses: [429],
    } as const;

    expect(() => buildOpenApiDocument([...coreEndpoints, ...coreEndpoints])).toThrow(
      /Duplicate OpenAPI operation/,
    );
    expect(() =>
      buildOpenApiDocument([
        ...coreEndpoints,
        { ...extensionEndpoint, responseSchemaName: 'HealthResponse' },
      ]),
    ).toThrow(/Conflicting OpenAPI schema name/);
    expect(() =>
      buildOpenApiDocument([
        ...coreEndpoints,
        extensionEndpoint,
        { ...extensionEndpoint, path: '/v1/example-extension/other-status' },
      ]),
    ).toThrow(/Duplicate OpenAPI operationId/);
  });
});
