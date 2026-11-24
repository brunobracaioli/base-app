import { stringify } from 'yaml';
import * as z from 'zod';

import { coreEndpoints, baseResponseSchemas, RateLimitPolicySchema } from './endpoints.js';
import { extensionEndpoints } from './extensions/index.js';
import type { EndpointContract } from './endpoints.js';

type OpenApiResponse = {
  readonly description: string;
  readonly content: Readonly<
    Record<
      string,
      {
        readonly schema: Readonly<Record<string, unknown>>;
      }
    >
  >;
};

type OpenApiOperation = {
  readonly operationId: string;
  readonly summary: string;
  readonly security: readonly Readonly<Record<string, readonly string[]>>[];
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
  readonly 'x-rate-limit-key': string;
  readonly 'x-rate-limit-limit': number;
  readonly 'x-rate-limit-window-sec': number;
  readonly 'x-rate-limit-ip-limit': number;
  readonly 'x-rate-limit-failure': 'closed' | 'open';
};

type OpenApiDocument = {
  readonly openapi: '3.1.0';
  readonly info: { readonly title: string; readonly version: string };
  readonly servers: readonly { readonly url: string }[];
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
  readonly components: {
    readonly schemas: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly securitySchemes: {
      readonly bearerAuth: {
        readonly type: 'http';
        readonly scheme: 'bearer';
        readonly bearerFormat: 'JWT';
      };
    };
  };
};

function toOpenApiSchema(schema: z.ZodType): Readonly<Record<string, unknown>> {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
  }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}

function responseContent(schemaName: string): OpenApiResponse['content'] {
  return {
    'application/json': {
      schema: { $ref: `#/components/schemas/${schemaName}` },
    },
  };
}

function problemContent(): OpenApiResponse['content'] {
  return {
    'application/problem+json': {
      schema: { $ref: '#/components/schemas/ProblemDetails' },
    },
  };
}

function buildOperation(endpoint: EndpointContract): OpenApiOperation {
  const responses: Record<string, OpenApiResponse> = {
    [String(endpoint.successStatus)]: {
      description: endpoint.successDescription,
      content: responseContent(endpoint.responseSchemaName),
    },
  };

  for (const status of endpoint.rateLimitErrorStatuses) {
    responses[String(status)] = {
      description: 'The request exceeded the configured rate limit.',
      content: problemContent(),
    };
  }

  return {
    operationId: endpoint.operationId,
    summary: endpoint.summary,
    security: endpoint.security,
    responses,
    'x-rate-limit-key': endpoint.rateLimit.key,
    'x-rate-limit-limit': endpoint.rateLimit.limit,
    'x-rate-limit-window-sec': endpoint.rateLimit.windowSec,
    'x-rate-limit-ip-limit': endpoint.rateLimit.ipLimit,
    'x-rate-limit-failure': endpoint.rateLimit.onStoreFailure,
  };
}

export function buildOpenApiDocument(
  endpoints: readonly EndpointContract[] = [...coreEndpoints, ...extensionEndpoints],
): OpenApiDocument {
  const paths: Record<string, Record<string, OpenApiOperation>> = {};
  const responseSchemas = new Map<string, z.ZodType>(Object.entries(baseResponseSchemas));
  const operationIds = new Set<string>();

  for (const endpoint of endpoints) {
    RateLimitPolicySchema.parse(endpoint.rateLimit);
    if (operationIds.has(endpoint.operationId)) {
      throw new Error(`Duplicate OpenAPI operationId: ${endpoint.operationId}`);
    }
    operationIds.add(endpoint.operationId);

    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(endpoint.responseSchemaName)) {
      throw new Error(`Invalid response schema name: ${endpoint.responseSchemaName}`);
    }

    const registeredSchema = responseSchemas.get(endpoint.responseSchemaName);
    if (registeredSchema !== undefined && registeredSchema !== endpoint.responseSchema) {
      throw new Error(`Conflicting OpenAPI response schema name: ${endpoint.responseSchemaName}`);
    }
    responseSchemas.set(endpoint.responseSchemaName, endpoint.responseSchema);

    const pathOperations = paths[endpoint.path] ?? {};
    if (pathOperations[endpoint.method] !== undefined) {
      throw new Error(
        `Duplicate OpenAPI operation: ${endpoint.method.toUpperCase()} ${endpoint.path}`,
      );
    }
    pathOperations[endpoint.method] = buildOperation(endpoint);
    paths[endpoint.path] = pathOperations;
  }

  const schemas = Object.fromEntries(
    [...responseSchemas.entries()].map(([name, schema]) => [name, toOpenApiSchema(schema)]),
  );

  return {
    openapi: '3.1.0',
    info: { title: 'base-app API', version: '1.0.0' },
    servers: [{ url: '/api' }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
  };
}

export function generateOpenApiYaml(): string {
  return stringify(buildOpenApiDocument(), {
    lineWidth: 0,
    sortMapEntries: true,
  });
}
