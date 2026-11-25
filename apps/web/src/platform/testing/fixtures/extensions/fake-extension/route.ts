import * as z from 'zod';

import { defineRoute } from '../../../../http';

export const GET = defineRoute({
  operationId: 'getFakeExtensionFixture',
  auth: { kind: 'public' },
  rateLimit: { key: 'ip', limit: 60, windowSec: 60, onStoreFailure: 'open' },
  output: z.strictObject({ status: z.literal('ok') }),
  handler: async () => ({ status: 'ok' }),
});
