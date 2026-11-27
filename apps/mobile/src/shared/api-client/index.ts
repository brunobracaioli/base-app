import * as Application from 'expo-application';
import * as Sentry from '@sentry/react-native';
import { Platform } from 'react-native';

import { unavailableSessionPort } from '../../features/auth/model/auth-ports';
import { translateMobile } from '../i18n';
import { addAppBreadcrumb } from '../telemetry/sentry';
import { publishApiAppGate } from './app-gate-events';
import {
  createApiClient,
  createUuidV7,
  type ApiClient,
  type ApiEndpoint,
  type ApiRequestOptions,
  type ApiSessionPort,
} from './api-client';

export { ApiRequestError, createApiClient, createUuidV7 } from './api-client';
export type {
  ApiAppGate,
  ApiClient,
  ApiEndpoint,
  ApiRequestOptions,
  ApiSessionPort,
} from './api-client';
export { publishApiAppGate, subscribeApiAppGates } from './app-gate-events';

const unavailableApiSession: ApiSessionPort = {
  getAccessToken: () => unavailableSessionPort.getCurrentAccessToken(),
  refreshSession: async () => null,
  signOutLocal: () => unavailableSessionPort.signOutLocal(),
};

let defaultClient: ApiClient | null = null;
type ApiSessionRegistration = {
  readonly id: symbol;
  readonly session: ApiSessionPort;
  readonly onAccountDeleted: (userId: string | null) => Promise<void>;
};
const apiSessionRegistrations: ApiSessionRegistration[] = [];

function activeApiSession(): ApiSessionPort {
  return (
    apiSessionRegistrations[apiSessionRegistrations.length - 1]?.session ?? unavailableApiSession
  );
}

function activeAccountDeletedHandler(userId: string | null): Promise<void> {
  return (
    apiSessionRegistrations[apiSessionRegistrations.length - 1]?.onAccountDeleted(userId) ??
    Promise.resolve()
  );
}

/** Installs the active Auth session for the shared API client. */
export function installApiSession(
  session: ApiSessionPort,
  onAccountDeleted: (userId: string | null) => Promise<void> = async () => undefined,
): () => void {
  const registration: ApiSessionRegistration = {
    id: Symbol('shared-api-session'),
    session,
    onAccountDeleted,
  };
  apiSessionRegistrations.push(registration);
  defaultClient = null;

  return () => {
    const index = apiSessionRegistrations.findIndex((entry) => entry.id === registration.id);
    if (index !== -1) {
      apiSessionRegistrations.splice(index, 1);
      defaultClient = null;
    }
  };
}

function getDefaultClient(): ApiClient {
  if (defaultClient !== null) {
    return defaultClient;
  }

  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    throw new Error('The mobile API client cannot run on this platform.');
  }

  defaultClient = createApiClient({
    baseUrl: process.env.EXPO_PUBLIC_API_URL ?? '',
    appVersion: Application.nativeApplicationVersion ?? '0.0.0',
    platform: Platform.OS,
    fetch: globalThis.fetch,
    session: activeApiSession(),
    createRequestId: createUuidV7,
    translate: translateMobile,
    telemetry: {
      onRequest: ({ requestId, method }) => {
        addAppBreadcrumb('http.request', 'API request sent', { requestId, method });
      },
      onResponse: ({ requestId, serverRequestId, status }) => {
        addAppBreadcrumb('http.response', 'API response received', {
          requestId,
          status,
          ...(serverRequestId === undefined ? {} : { serverRequestId }),
        });
      },
    },
    onContractMismatch: ({ requestId }) => {
      Sentry.captureMessage('client.contract_mismatch', {
        level: 'error',
        extra: { requestId },
      });
    },
    onAppGate: publishApiAppGate,
    onAccountDeleted: (userId) => activeAccountDeletedHandler(userId),
  });
  return defaultClient;
}

export const apiClient: ApiClient = {
  request<T>(endpoint: ApiEndpoint<T>, options?: ApiRequestOptions): Promise<T> {
    return getDefaultClient().request(endpoint, options);
  },
};
