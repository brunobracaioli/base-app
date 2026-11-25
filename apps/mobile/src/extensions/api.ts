import { useSyncExternalStore } from 'react';

import type { ApiClient, ApiEndpoint, ApiRequestOptions } from '../shared/api-client/api-client';
import {
  unavailableAuthOperations,
  unavailableSessionPort,
} from '../features/auth/model/auth-ports';
import type { SessionPort } from '../features/auth/model/auth-ports';
import type { AuthErrorKey, SessionSummary } from './types';
import {
  createExtensionApi,
  getConfiguredExtensionApi,
  subscribeExtensionApiRuntime,
  unavailableExtensionApiClient,
  type ExtensionApiRuntime,
  type ExtensionAuthApi,
} from '../composition/extension-api';

const unavailableRuntime: ExtensionApiRuntime = createExtensionApi({
  auth: unavailableAuthOperations,
  session: unavailableSessionPort,
  apiClient: unavailableExtensionApiClient,
  captchaProvider: null,
});

function getCurrentRuntime(): ExtensionApiRuntime {
  return getConfiguredExtensionApi() ?? unavailableRuntime;
}

type SessionSummaryCacheEntry = {
  readonly userId: string | null;
  readonly isAnonymous: boolean | null;
  readonly summary: SessionSummary | null;
};

const sessionSummaryCache = new WeakMap<SessionPort, SessionSummaryCacheEntry>();

function readSessionSummary(session: SessionPort): SessionSummary | null {
  const current = session.getSessionSummary();
  const cached = sessionSummaryCache.get(session);
  if (current === null) {
    if (cached?.summary === null) {
      return null;
    }
    sessionSummaryCache.set(session, { userId: null, isAnonymous: null, summary: null });
    return null;
  }

  if (
    cached?.summary !== null &&
    cached?.userId === current.userId &&
    cached?.isAnonymous === current.isAnonymous
  ) {
    return cached.summary;
  }

  const summary = Object.freeze({ userId: current.userId, isAnonymous: current.isAnonymous });
  sessionSummaryCache.set(session, {
    userId: current.userId,
    isAnonymous: current.isAnonymous,
    summary,
  });
  return summary;
}

function subscribeToSessionSummary(onStoreChange: () => void): () => void {
  let session = getCurrentRuntime().sessionPort;
  let unsubscribeSession = session.subscribe(onStoreChange);
  const unsubscribeRuntime = subscribeExtensionApiRuntime(() => {
    const currentSession = getCurrentRuntime().sessionPort;
    if (currentSession !== session) {
      unsubscribeSession();
      session = currentSession;
      unsubscribeSession = session.subscribe(onStoreChange);
    }
    onStoreChange();
  });

  return () => {
    unsubscribeRuntime();
    unsubscribeSession();
  };
}

function getSessionSummarySnapshot(): SessionSummary | null {
  return readSessionSummary(getCurrentRuntime().sessionPort);
}

function getServerSessionSummarySnapshot(): null {
  return null;
}

export const extensionAuth: ExtensionAuthApi = Object.freeze({
  signInAnonymously: () => getCurrentRuntime().extensionAuth.signInAnonymously(),
  signInWithIdToken: (input) => getCurrentRuntime().extensionAuth.signInWithIdToken(input),
  linkIdentity: (input) => getCurrentRuntime().extensionAuth.linkIdentity(input),
  unlinkIdentity: (input) => getCurrentRuntime().extensionAuth.unlinkIdentity(input),
  updateEmail: (email) => getCurrentRuntime().extensionAuth.updateEmail(email),
  verifyEmailChangeOtp: (input) => getCurrentRuntime().extensionAuth.verifyEmailChangeOtp(input),
  refreshSession: () => getCurrentRuntime().extensionAuth.refreshSession(),
  signOutEverywhere: () => getCurrentRuntime().extensionAuth.signOutEverywhere(),
  withPreviousSession: (fn) => getCurrentRuntime().extensionAuth.withPreviousSession(fn),
});

export const extensionApiClient: ApiClient = Object.freeze({
  request<T>(endpoint: ApiEndpoint<T>, options?: ApiRequestOptions): Promise<T> {
    return getCurrentRuntime().extensionApiClient.request(endpoint, options);
  },
});

export function useSessionSummary() {
  return useSyncExternalStore(
    subscribeToSessionSummary,
    getSessionSummarySnapshot,
    getServerSessionSummarySnapshot,
  );
}

export type { AuthErrorKey };
