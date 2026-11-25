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
      'GET /v1/me',
      'PATCH /v1/me',
      'POST /v1/me/consents',
    ]);
    expect(coreEndpoints[0]?.security).toEqual([]);
    expect(coreEndpoints.slice(1).every((endpoint) => endpoint.security.length > 0)).toBe(true);
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
    expect(document.info.version).toBe('1.1.0');
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
    expect(() => UpdateProfileBody.parse({ displayName: 'Ana', userId: me.id })).toThrow(
      ZodError,
    );

    const consent = { document: 'terms', version: '2026-11-24' };
    expect(ConsentBody.parse(consent)).toEqual(consent);
    expect(() => ConsentBody.parse({ ...consent, extra: true })).toThrow(ZodError);
    expect(() => ConsentBody.parse({ ...consent, version: '2026-2-4' })).toThrow(ZodError);
  });

  it('declares authenticated user limits and OpenAPI request/problem responses', () => {
    const getMe = coreEndpoints.find(({ operationId }) => operationId === 'getMe');
    const updateMe = coreEndpoints.find(({ operationId }) => operationId === 'updateMe');
    const acceptConsent = coreEndpoints.find(
      ({ operationId }) => operationId === 'acceptConsent',
    );
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
