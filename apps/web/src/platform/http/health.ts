import { coreEndpoints } from '@base-app/contracts';

import { defineRoute } from './index';

const healthContract = coreEndpoints.find((endpoint) => endpoint.operationId === 'getHealth');

if (!healthContract) throw new Error('The health endpoint contract is missing.');

export const GET = defineRoute({
  operationId: healthContract.operationId,
  auth: { kind: 'public' },
  rateLimit: healthContract.rateLimit,
  output: healthContract.responseSchema,
  handler: async () => ({ status: 'ok' }),
});
