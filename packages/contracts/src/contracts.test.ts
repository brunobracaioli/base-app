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
  ProblemDetailsSchema,
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
    ]);
    expect(coreEndpoints.every((endpoint) => endpoint.security.length === 0)).toBe(true);
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
    ).toThrow(/Conflicting OpenAPI response schema name/);
    expect(() =>
      buildOpenApiDocument([
        ...coreEndpoints,
        extensionEndpoint,
        { ...extensionEndpoint, path: '/v1/example-extension/other-status' },
      ]),
    ).toThrow(/Duplicate OpenAPI operationId/);
  });
});
