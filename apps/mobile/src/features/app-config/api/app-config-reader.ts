import { AppConfigResponse, coreEndpoints, type AppConfigResponseValue } from '@base-app/contracts';

import { apiClient, type ApiClient, type ApiEndpoint } from '../../../shared/api-client';

const appConfigContract = coreEndpoints.find(({ operationId }) => operationId === 'getAppConfig');
const appConfigTimeoutMs = 3_000;

if (appConfigContract === undefined || appConfigContract.security.length !== 0) {
  throw new Error('The public app configuration endpoint is unavailable.');
}

const appConfigEndpoint: ApiEndpoint<AppConfigResponseValue> = {
  method: appConfigContract.method,
  path: appConfigContract.path,
  security: appConfigContract.security,
  successStatus: appConfigContract.successStatus,
  responseSchema: AppConfigResponse,
};

export type AppConfigReader = (signal?: AbortSignal) => Promise<AppConfigResponseValue>;

export function createAppConfigReader(client: ApiClient = apiClient): AppConfigReader {
  return (signal?: AbortSignal): Promise<AppConfigResponseValue> =>
    client.request(
      appConfigEndpoint,
      signal === undefined
        ? { totalTimeoutMs: appConfigTimeoutMs }
        : { signal, totalTimeoutMs: appConfigTimeoutMs },
    );
}

export const readAppConfig = createAppConfigReader();
