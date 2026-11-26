import { stringify } from 'yaml';
import * as z from 'zod';

import {
  coreEndpoints,
  baseResponseSchemas,
  RateLimitPolicySchema,
  type EndpointResponseHeader,
} from './endpoints.js';
import { extensionEndpoints } from './extensions/index.js';
import type { EndpointContract } from './endpoints.js';

type OpenApiResponse = {
  readonly description: string;
  readonly content?: OpenApiContent;
  readonly headers?: Readonly<
    Record<
      string,
      { readonly description: string; readonly schema: Readonly<Record<string, unknown>> }
    >
  >;
};

type OpenApiContent = Readonly<
  Record<
    string,
    {
      readonly schema: Readonly<Record<string, unknown>>;
    }
  >
>;

type OpenApiOperation = {
  readonly operationId: string;
  readonly summary: string;
  readonly security: readonly Readonly<Record<string, readonly string[]>>[];
  readonly requestBody?: {
    readonly description: string;
    readonly required: boolean;
    readonly content: Readonly<
      Record<
        string,
        {
          readonly schema: Readonly<Record<string, unknown>>;
        }
      >
    >;
  };
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
  readonly 'x-rate-limit-key': string;
  readonly 'x-rate-limit-limit': number;
  readonly 'x-rate-limit-window-sec': number;
  readonly 'x-rate-limit-ip-limit': number;
  readonly 'x-rate-limit-failure': 'closed' | 'open';
};

type OpenApiDocument = {
  readonly openapi: '3.1.0';
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description: string;
  };
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

function responseContent(schemaName: string): OpenApiContent {
  return {
    'application/json': {
      schema: { $ref: `#/components/schemas/${schemaName}` },
    },
  };
}

function problemContent(): OpenApiContent {
  return {
    'application/problem+json': {
      schema: { $ref: '#/components/schemas/ProblemDetails' },
    },
  };
}

function toOpenApiHeaders(
  headers: Readonly<Record<string, EndpointResponseHeader>>,
): NonNullable<OpenApiResponse['headers']> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, header]) => [
      name,
      { description: header.description, schema: toOpenApiSchema(header.schema) },
    ]),
  );
}

function buildOperation(endpoint: EndpointContract): OpenApiOperation {
  const hasResponseSchema =
    endpoint.responseSchemaName !== undefined && endpoint.responseSchema !== undefined;
  if ((endpoint.responseSchemaName === undefined) !== (endpoint.responseSchema === undefined)) {
    throw new Error(`Incomplete success response schema for ${endpoint.operationId}`);
  }
  if (endpoint.successStatus === 204 && hasResponseSchema) {
    throw new Error(`A 204 response cannot define a body schema for ${endpoint.operationId}`);
  }
  if (endpoint.successStatus !== 204 && !hasResponseSchema) {
    throw new Error(`A response schema is required for ${endpoint.operationId}`);
  }

  const successResponse: OpenApiResponse = {
    description: endpoint.successDescription,
    ...(endpoint.successHeaders !== undefined
      ? { headers: toOpenApiHeaders(endpoint.successHeaders) }
      : {}),
    ...(hasResponseSchema && endpoint.responseSchemaName !== undefined
      ? { content: responseContent(endpoint.responseSchemaName) }
      : {}),
  };
  const responses: Record<string, OpenApiResponse> = {
    [String(endpoint.successStatus)]: successResponse,
  };

  for (const problem of endpoint.problemResponses ?? []) {
    responses[String(problem.status)] = {
      description: problem.description,
      content: problemContent(),
      ...(problem.headers !== undefined ? { headers: toOpenApiHeaders(problem.headers) } : {}),
    };
  }

  for (const status of endpoint.rateLimitErrorStatuses) {
    responses[String(status)] = {
      description: 'The request exceeded the configured rate limit.',
      content: problemContent(),
    };
  }

  const requestBody = endpoint.requestBody
    ? {
        description: endpoint.requestBody.description,
        required: endpoint.requestBody.required ?? true,
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${endpoint.requestBody.schemaName}` },
          },
        },
      }
    : undefined;

  return {
    operationId: endpoint.operationId,
    summary: endpoint.summary,
    security: endpoint.security,
    ...(requestBody ? { requestBody } : {}),
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
  const schemas = new Map<string, z.ZodType>(Object.entries(baseResponseSchemas));
  const operationIds = new Set<string>();

  for (const endpoint of endpoints) {
    RateLimitPolicySchema.parse(endpoint.rateLimit);
    if (operationIds.has(endpoint.operationId)) {
      throw new Error(`Duplicate OpenAPI operationId: ${endpoint.operationId}`);
    }
    operationIds.add(endpoint.operationId);

    const registerSchema = (name: string, schema: z.ZodType, role: string): void => {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
        throw new Error(`Invalid OpenAPI ${role} schema name: ${name}`);
      }
      const registeredSchema = schemas.get(name);
      if (registeredSchema !== undefined && registeredSchema !== schema) {
        throw new Error(`Conflicting OpenAPI schema name: ${name}`);
      }
      schemas.set(name, schema);
    };

    if (endpoint.requestBody !== undefined) {
      registerSchema(endpoint.requestBody.schemaName, endpoint.requestBody.schema, 'request');
    }
    if (endpoint.responseSchemaName !== undefined && endpoint.responseSchema !== undefined) {
      registerSchema(endpoint.responseSchemaName, endpoint.responseSchema, 'response');
    }

    const pathOperations = paths[endpoint.path] ?? {};
    if (pathOperations[endpoint.method] !== undefined) {
      throw new Error(
        `Duplicate OpenAPI operation: ${endpoint.method.toUpperCase()} ${endpoint.path}`,
      );
    }
    pathOperations[endpoint.method] = buildOperation(endpoint);
    paths[endpoint.path] = pathOperations;
  }

  const componentSchemas = Object.fromEntries(
    [...schemas.entries()].map(([name, schema]) => [name, toOpenApiSchema(schema)]),
  );

  return {
    openapi: '3.1.0',
    info: {
      title: 'base-app API',
      version: '1.2.0',
      description:
        'Compatible additive revision: adds public app configuration and server gate responses for existing operations.',
    },
    servers: [{ url: '/api' }],
    paths,
    components: {
      schemas: componentSchemas,
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
