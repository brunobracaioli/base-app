import * as z from 'zod';

import { HealthResponseSchema } from './health.schema.js';
import { ProblemDetailsSchema } from './problem.schema.js';

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
  readonly responseSchemaName: string;
  readonly responseSchema: z.ZodType;
  readonly rateLimitErrorStatuses: readonly number[];
};

/** Core endpoint contract owned by the base app. The handler arrives in Wave 1. */
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
] as const satisfies readonly EndpointContract[];

export const baseResponseSchemas = {
  HealthResponse: HealthResponseSchema,
  ProblemDetails: ProblemDetailsSchema,
} as const satisfies Readonly<Record<string, z.ZodType>>;

export const RateLimitProblemSchema = ProblemDetailsSchema;
