import * as z from 'zod';

import { defineRoute } from './index';

const output = z.strictObject({ ok: z.boolean() });

// @ts-expect-error auth is required on every route
defineRoute({
  operationId: 'getMissingAuth',
  rateLimit: { key: 'ip', limit: 60, windowSec: 60, onStoreFailure: 'closed' },
  output,
  handler: async () => ({ ok: true }),
});

defineRoute({
  operationId: 'getMissingRateLimitFailure',
  auth: { kind: 'public' },
  // @ts-expect-error onStoreFailure must be explicit
  rateLimit: { key: 'ip', limit: 60, windowSec: 60 },
  output,
  handler: async () => ({ ok: true }),
});

defineRoute({
  operationId: 'postNoContent',
  auth: { kind: 'user' },
  rateLimit: { key: 'user', limit: 20, windowSec: 3600, onStoreFailure: 'closed' },
  successStatus: 204,
  output: z.undefined(),
  handler: async () => undefined,
});

defineRoute({
  operationId: 'getUnsupportedSuccessStatus',
  auth: { kind: 'public' },
  rateLimit: { key: 'ip', limit: 60, windowSec: 60, onStoreFailure: 'closed' },
  // @ts-expect-error only the supported success statuses are accepted
  successStatus: 201,
  output,
  handler: async () => ({ ok: true }),
});

// @ts-expect-error a 204 route must validate and return undefined
defineRoute({
  operationId: 'postInvalidNoContentOutput',
  auth: { kind: 'user' },
  rateLimit: { key: 'user', limit: 20, windowSec: 3600, onStoreFailure: 'closed' },
  successStatus: 204,
  output,
  handler: async () => ({ ok: true }),
});
