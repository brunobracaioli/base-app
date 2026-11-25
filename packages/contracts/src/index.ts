export { HealthResponseSchema } from './health.schema.js';
export type { HealthResponse } from './health.schema.js';
export { Locale, Me, UpdateProfileBody } from './identity.js';
export type { MeResponse, UpdateProfileBodyInput } from './identity.js';
export {
  baseResponseSchemas,
  coreEndpoints,
  RateLimitPolicySchema,
  RateLimitProblemSchema,
} from './endpoints.js';
export type { EndpointContract, RateLimitPolicy } from './endpoints.js';
export { extensionEndpoints } from './extensions/index.js';
export { buildOpenApiDocument, generateOpenApiYaml } from './openapi.js';
export { ProblemDetailsSchema } from './problem.schema.js';
export type { ProblemDetails } from './problem.schema.js';
export { ConsentBody } from './privacy.js';
export type { ConsentBodyInput } from './privacy.js';
