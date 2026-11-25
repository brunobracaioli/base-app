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
