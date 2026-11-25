import * as z from 'zod';

import { HealthResponseSchema } from './health.schema.js';
import { Me, UpdateProfileBody } from './identity.js';
import { ProblemDetailsSchema } from './problem.schema.js';
import { ConsentBody } from './privacy.js';

export const RateLimitPolicySchema = z.strictObject({
  key: z.enum(['ip', 'user', 'global']),
  limit: z.number().int().positive(),
  windowSec: z.number().int().positive(),
  ipLimit: z.number().int().positive(),
  onStoreFailure: z.enum(['closed', 'open']),
});

export type RateLimitPolicy = z.infer<typeof RateLimitPolicySchema>;

export type EndpointContract = {
  readonly method: 'get' | 'post' | 'patch' | 'delete';
  readonly path: `/${string}`;
  readonly operationId: string;
  readonly summary: string;
  readonly security: readonly Readonly<Record<string, readonly string[]>>[];
  readonly rateLimit: RateLimitPolicy;
  readonly successStatus: number;
  readonly successDescription: string;
  readonly requestBody?: {
    readonly schemaName: string;
    readonly schema: z.ZodType;
    readonly description: string;
    readonly required?: boolean;
  };
  readonly responseSchemaName?: string;
  readonly responseSchema?: z.ZodType;
  readonly problemResponses?: readonly {
    readonly status: number;
    readonly description: string;
  }[];
  readonly rateLimitErrorStatuses: readonly number[];
};

/** Core endpoint contracts owned by the base app. */
export const coreEndpoints = [
  {
    method: 'get',
    path: '/v1/health',
    operationId: 'getHealth',
    summary: 'Health check',
    security: [],
    rateLimit: {
      key: 'ip',
      limit: 60,
      windowSec: 60,
      ipLimit: 60,
      onStoreFailure: 'open',
    },
    successStatus: 200,
    successDescription: 'The service is healthy.',
    responseSchemaName: 'HealthResponse',
    responseSchema: HealthResponseSchema,
    rateLimitErrorStatuses: [429],
  },
  {
    method: 'get',
    path: '/v1/me',
    operationId: 'getMe',
    summary: 'Read the authenticated user profile and consent state',
    security: [{ bearerAuth: [] }],
    rateLimit: {
      key: 'user',
      limit: 60,
      windowSec: 60,
      ipLimit: 120,
      onStoreFailure: 'closed',
    },
    successStatus: 200,
    successDescription: 'The authenticated user profile and consent state.',
    responseSchemaName: 'Me',
    responseSchema: Me,
    problemResponses: [
      {
        status: 401,
        description:
          'The authentication token is missing, invalid, expired, or belongs to a deleted account.',
      },
      { status: 503, description: 'Authentication or rate limiting is unavailable.' },
    ],
    rateLimitErrorStatuses: [429],
  },
  {
    method: 'patch',
    path: '/v1/me',
    operationId: 'updateMe',
    summary: 'Update the authenticated user profile',
    security: [{ bearerAuth: [] }],
    rateLimit: {
      key: 'user',
      limit: 20,
      windowSec: 60,
      ipLimit: 120,
      onStoreFailure: 'closed',
    },
    successStatus: 200,
    successDescription: 'The updated authenticated user profile and consent state.',
    requestBody: {
      schemaName: 'UpdateProfileBody',
      schema: UpdateProfileBody,
      description: 'Profile fields to update. At least one field is required.',
    },
    responseSchemaName: 'Me',
    responseSchema: Me,
    problemResponses: [
      { status: 400, description: 'The request body failed validation.' },
      {
        status: 401,
        description:
          'The authentication token is missing, invalid, expired, or belongs to a deleted account.',
      },
      { status: 503, description: 'Authentication or rate limiting is unavailable.' },
    ],
    rateLimitErrorStatuses: [429],
  },
  {
    method: 'post',
    path: '/v1/me/consents',
    operationId: 'acceptConsent',
    summary: 'Record acceptance of a current legal document version',
    security: [{ bearerAuth: [] }],
    rateLimit: {
      key: 'user',
      limit: 20,
      windowSec: 60 * 60,
      ipLimit: 120,
      onStoreFailure: 'closed',
    },
    successStatus: 204,
    successDescription: 'The consent was accepted or had already been accepted.',
    requestBody: {
      schemaName: 'ConsentBody',
      schema: ConsentBody,
      description: 'The legal document and current version being accepted.',
    },
    problemResponses: [
      { status: 400, description: 'The request body failed validation.' },
      {
        status: 401,
        description:
          'The authentication token is missing, invalid, expired, or belongs to a deleted account.',
      },
      {
        status: 409,
        description: 'The submitted legal document version is no longer current.',
      },
      { status: 503, description: 'Authentication or rate limiting is unavailable.' },
    ],
    rateLimitErrorStatuses: [429],
  },
] as const satisfies readonly EndpointContract[];

export const baseResponseSchemas = {
  HealthResponse: HealthResponseSchema,
  Me,
  ProblemDetails: ProblemDetailsSchema,
} as const satisfies Readonly<Record<string, z.ZodType>>;

export const RateLimitProblemSchema = ProblemDetailsSchema;
