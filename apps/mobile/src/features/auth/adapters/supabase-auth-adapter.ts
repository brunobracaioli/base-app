import * as Sentry from '@sentry/react-native';
import type {
  Provider,
  Session,
  SignInWithOAuthCredentials,
  SupabaseClient,
  UserIdentity,
} from '@supabase/supabase-js';
import * as z from 'zod';

import type {
  AuthErrorKey,
  CaptchaProvider,
  Locale,
  Result,
  SessionSummary,
} from '../../../extensions/types';
import type {
  AuthResult,
  AuthTransportPort,
  PasswordSetupPurpose,
  StepUpMethod,
} from '../model/auth-contracts';
import type {
  AuthOperationsPort,
  CapturedPreviousSessionPort,
  EmailChangeOtpInput,
  IdentityTokenInput,
  LinkIdentityInput,
  SessionPort,
  UnlinkIdentityInput,
} from '../model/auth-ports';
import { withCaptcha } from '../api/with-captcha';
import { createEncryptedStorage, type AuthStorage } from './encrypted-storage';
import { mapAuthError } from './auth-errors';
import { createStepUpClient } from './step-up-client';
import {
  createSupabaseClient,
  getSupabaseStorageKey,
  type AuthClientConfig,
} from './supabase-client';

const SessionRecordSchema = z
  .object({
    access_token: z.string().min(1).max(16_384),
    refresh_token: z.string().min(1).max(16_384),
    user: z
      .object({
        id: z.uuid(),
        is_anonymous: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const AmrClaimsSchema = z
  .object({
    amr: z
      .array(
        z.object({
          method: z.string(),
          timestamp: z.union([z.number(), z.string()]).optional(),
        }),
      )
      .optional(),
  })
  .passthrough();
const RecoveryRevocationMarkerSchema = z.strictObject({
  userIds: z.array(z.uuid()),
});
const RECOVERY_REVOCATION_STORAGE_KEY = 'base-app.auth-recovery-revocations.v1';

type SessionRecord = z.infer<typeof SessionRecordSchema>;
type AdapterResult<T> = Result<T, AuthErrorKey>;
export type SupabaseAuthAdapterOptions = {
  readonly supabaseUrl: string;
  readonly publishableKey: string;
  readonly captchaProvider: CaptchaProvider | null;
  readonly recentAuthMaxAgeSec: () => number;
};

type SupabaseAuthAdapterDependencies = SupabaseAuthAdapterOptions & {
  readonly storage?: AuthStorage;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
  readonly reportAuthEvent?: (event: 'email_send_rate_limited') => void;
  readonly createPrimaryClient?: (config: AuthClientConfig) => SupabaseClient;
  readonly createSecondaryClient?: (
    config: Omit<AuthClientConfig, 'persistSession'>,
  ) => SupabaseClient;
};

export type SupabaseAuthAdapter = {
  readonly auth: AuthTransportPort;
  readonly operations: AuthOperationsPort;
  readonly session: SessionPort;
  readonly getAuthContext: () => Promise<{
    readonly accessToken: string | null;
    readonly userId: string | null;
  }>;
  readonly signOutLocalIfUserMatches: (userId: string) => Promise<boolean>;
  readonly initialize: () => Promise<void>;
  readonly startAutoRefresh: () => void;
  readonly stopAutoRefresh: () => void;
  readonly handleAccountDeleted: (userId: string) => boolean;
  readonly dispose: () => void;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sdkError(value: unknown): unknown | null {
  if (!isObject(value) || !('error' in value)) return null;
  return value.error ?? null;
}

function isTransientAuthError(error: unknown): boolean {
  if (!isObject(error)) return false;
  return (
    error.name === 'AuthRetryableFetchError' ||
    error.code === 'fetch_error' ||
    (typeof error.status === 'number' && error.status >= 500)
  );
}

function sessionFromResult(value: unknown): SessionRecord | null {
  if (!isObject(value) || !isObject(value.data) || !('session' in value.data)) return null;
  const parsed = SessionRecordSchema.safeParse(value.data.session);
  return parsed.success ? parsed.data : null;
}

function sessionFromStorage(value: string | null): SessionRecord | null {
  if (value === null) return null;
  try {
    const parsedJson: unknown = JSON.parse(value);
    const parsed = SessionRecordSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function summarizeSession(session: SessionRecord): SessionSummary {
  return Object.freeze({
    userId: session.user.id,
    isAnonymous: session.user.is_anonymous ?? false,
  });
}

function claimsFromAccessToken(accessToken: string): z.infer<typeof AmrClaimsSchema> | null {
  const payload = accessToken.split('.')[1];
  if (payload === undefined || payload.length === 0) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const binary = globalThis.atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsedJson: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const parsed = AmrClaimsSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function authMethodFromSession(session: SessionRecord): {
  readonly method: StepUpMethod | null;
  readonly recentAuthAt: number | null;
} {
  const claims = claimsFromAccessToken(session.access_token);
  const entries = (claims?.amr ?? [])
    .map((entry) => ({
      method: entry.method,
      timestamp: typeof entry.timestamp === 'string' ? Number(entry.timestamp) : entry.timestamp,
    }))
    .filter((entry) => entry.timestamp !== undefined && Number.isFinite(entry.timestamp));
  entries.sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0));
  const latest = entries[0];
  const method =
    latest?.method === 'password'
      ? 'email_password'
      : latest?.method === 'otp'
        ? 'email_otp'
        : null;
  return {
    method,
    recentAuthAt: latest?.timestamp ?? null,
  };
}

function success<T>(value: T): AdapterResult<T> {
  return { ok: true, value };
}

function fail<T = never>(error: AuthErrorKey): AdapterResult<T> {
  return { ok: false, error };
}

export function createSupabaseAuthAdapter(
  options: SupabaseAuthAdapterOptions,
): SupabaseAuthAdapter {
  return createSupabaseAuthAdapterWithDependencies(options);
}

export function createSupabaseAuthAdapterWithDependencies(
  options: SupabaseAuthAdapterDependencies,
): SupabaseAuthAdapter {
  const storage = options.storage ?? createEncryptedStorage();
  const now = options.now ?? Date.now;
  const reportAuthEvent =
    options.reportAuthEvent ??
    ((event: 'email_send_rate_limited') =>
      Sentry.captureMessage('auth.email_send_rate_limited', {
        level: 'warning',
        tags: { event },
      }));
  const reportFailure = (error: unknown) => mapAuthError(error, reportAuthEvent);
  let authGeneration = 0;
  let activeMutationGeneration: number | null = null;
  let sessionEventsBlocked = false;
  let suppressedSessionEvents = 0;
  let disposed = false;
  let offlineSessionSummaryUserId: string | null = null;
  let primaryMutationQueue: Promise<void> = Promise.resolve();
  const requestsByGeneration = new Map<number, Set<AbortController>>();
  const sessionListeners = new Set<() => void>();
  let currentSummary: SessionSummary | null = null;
  let currentAuthMethod: StepUpMethod | null = null;
  let recentAuthAt: number | null = null;
  let provisionalClient: SupabaseClient | null = null;
  let provisionalPurpose: PasswordSetupPurpose | null = null;
  let provisionalUserId: string | null = null;
  let provisionalGeneration = 0;
  let provisionalPromotionGeneration: number | null = null;
  let stepUpClient: SupabaseClient | null = null;
  const recoveryRevocationUserIds = new Set<string>();
  let authSubscription:
    ReturnType<SupabaseClient['auth']['onAuthStateChange']>['data']['subscription'] | null = null;

  const storageKey = getSupabaseStorageKey(options.supabaseUrl);
  const createPrimaryClient = options.createPrimaryClient ?? createSupabaseClient;
  const createSecondaryClient = options.createSecondaryClient ?? createStepUpClient;
  const client = createPrimaryClient({
    supabaseUrl: options.supabaseUrl,
    publishableKey: options.publishableKey,
    persistSession: true,
    storage,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    onRequestController: (controller) => {
      const generation = authGeneration;
      const requests = requestsByGeneration.get(generation) ?? new Set<AbortController>();
      requests.add(controller);
      requestsByGeneration.set(generation, requests);
      return () => {
        requests.delete(controller);
        if (requests.size === 0) requestsByGeneration.delete(generation);
      };
    },
  });

  function publishSession(session: SessionRecord | null, notify = true): void {
    if (disposed) return;
    offlineSessionSummaryUserId = null;
    if (session === null) {
      currentSummary = null;
      currentAuthMethod = null;
      recentAuthAt = null;
    } else {
      currentSummary = summarizeSession(session);
      const authMetadata = authMethodFromSession(session);
      currentAuthMethod = authMetadata.method ?? currentAuthMethod;
      recentAuthAt = authMetadata.recentAuthAt;
    }
    if (!notify) return;
    for (const listener of sessionListeners) {
      try {
        listener();
      } catch {
        // Session subscribers cannot change the Auth result.
      }
    }
  }

  function abortRequestsBefore(generation: number): void {
    for (const [requestGeneration, controllers] of requestsByGeneration) {
      if (requestGeneration >= generation) continue;
      for (const controller of controllers) controller.abort();
    }
  }

  function advanceGeneration(blockSessionEvents: boolean): number {
    authGeneration += 1;
    if (blockSessionEvents) sessionEventsBlocked = true;
    abortRequestsBefore(authGeneration);
    return authGeneration;
  }

  function enqueuePrimary<T>(
    generation: number,
    action: () => Promise<T>,
    resultGeneration: (value: T) => number = () => generation,
  ): Promise<T | undefined> {
    const result = primaryMutationQueue.then(async () => {
      if (generation !== authGeneration) return undefined;
      activeMutationGeneration = generation;
      try {
        const value = await action();
        return resultGeneration(value) === authGeneration ? value : undefined;
      } finally {
        activeMutationGeneration = null;
      }
    });
    primaryMutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function mappedVoidResult(result: unknown): AdapterResult<void> {
    const error = sdkError(result);
    return error === null ? success(undefined) : fail(reportFailure(error));
  }

  async function mappedCall<T>(
    call: () => Promise<unknown>,
    project: (result: unknown) => AdapterResult<T> = mappedVoidResult as (
      result: unknown,
    ) => AdapterResult<T>,
  ): Promise<AdapterResult<T>> {
    try {
      return project(await call());
    } catch (error) {
      return fail(reportFailure(error));
    }
  }

  async function captchaCall<T>(
    action: Parameters<typeof withCaptcha>[1],
    call: (captchaToken: string | undefined) => Promise<unknown>,
    project: (result: unknown) => AdapterResult<T> = mappedVoidResult as (
      result: unknown,
    ) => AdapterResult<T>,
  ): Promise<AdapterResult<T>> {
    try {
      return await withCaptcha(options.captchaProvider, action, async (captchaToken) => {
        try {
          return project(await call(captchaToken));
        } catch (error) {
          return fail(reportFailure(error));
        }
      });
    } catch (error) {
      return fail(reportFailure(error));
    }
  }

  async function persistRecoveryRevocationMarkers(): Promise<void> {
    const userIds = [...recoveryRevocationUserIds].sort();
    if (userIds.length === 0) {
      await storage.removeItem(RECOVERY_REVOCATION_STORAGE_KEY);
      return;
    }
    await storage.setItem(RECOVERY_REVOCATION_STORAGE_KEY, JSON.stringify({ userIds }));
  }

  async function loadRecoveryRevocationMarkers(): Promise<void> {
    const stored = await storage.getItem(RECOVERY_REVOCATION_STORAGE_KEY);
    if (stored === null) return;
    try {
      const parsedJson: unknown = JSON.parse(stored);
      const parsed = RecoveryRevocationMarkerSchema.safeParse(parsedJson);
      if (!parsed.success) {
        await storage.removeItem(RECOVERY_REVOCATION_STORAGE_KEY).catch(() => undefined);
        return;
      }
      for (const userId of parsed.data.userIds) recoveryRevocationUserIds.add(userId);
    } catch {
      await storage.removeItem(RECOVERY_REVOCATION_STORAGE_KEY).catch(() => undefined);
    }
  }

  async function addRecoveryRevocationMarker(userId: string): Promise<AuthResult<void>> {
    recoveryRevocationUserIds.add(userId);
    try {
      await persistRecoveryRevocationMarkers();
      return success(undefined);
    } catch (error) {
      return fail(reportFailure(error));
    }
  }

  async function revokeOtherSessions(
    authClient: SupabaseClient,
    userId: string,
  ): Promise<AuthResult<void>> {
    if (!recoveryRevocationUserIds.has(userId)) return success(undefined);
    const result = await mappedCall(() => authClient.auth.signOut({ scope: 'others' }));
    if (!result.ok) return result;
    recoveryRevocationUserIds.delete(userId);
    await persistRecoveryRevocationMarkers().catch(() => undefined);
    return success(undefined);
  }

  function primarySessionFrom(result: unknown): SessionRecord | null {
    const session = sessionFromResult(result);
    if (session === null) return null;
    return SessionRecordSchema.parse(session);
  }

  function observeSessionEvent(event: string, session: Session | null): void {
    if (disposed || suppressedSessionEvents > 0) return;
    if (session === null) {
      if (event === 'INITIAL_SESSION' && offlineSessionSummaryUserId !== null) return;
      publishSession(null);
      return;
    }

    const parsed = SessionRecordSchema.safeParse(session);
    if (!parsed.success) return;
    if (recoveryRevocationUserIds.has(parsed.data.user.id)) {
      sessionEventsBlocked = true;
      return;
    }
    if (sessionEventsBlocked && activeMutationGeneration !== authGeneration) return;
    publishSession(parsed.data);
  }

  function createTransientClient(): SupabaseClient {
    return createSecondaryClient({
      supabaseUrl: options.supabaseUrl,
      publishableKey: options.publishableKey,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  async function discardTransient(clientToDiscard: SupabaseClient | null): Promise<void> {
    if (clientToDiscard === null) return;
    try {
      await clientToDiscard.auth.signOut({ scope: 'local' });
    } catch {
      // A private, in-memory client is discarded even when local cleanup fails.
    }
  }

  async function clearTransientClients(): Promise<void> {
    const provisional = provisionalClient;
    const stepUp = stepUpClient;
    provisionalGeneration += 1;
    provisionalPromotionGeneration = null;
    provisionalClient = null;
    provisionalPurpose = null;
    provisionalUserId = null;
    stepUpClient = null;
    await Promise.all([discardTransient(provisional), discardTransient(stepUp)]);
  }

  async function clearPrimaryLocalSession(): Promise<void> {
    try {
      await client.auth.signOut({ scope: 'local' });
    } catch {
      // Remove the encrypted value below even if the SDK cleanup fails.
    }
    await storage.removeItem(storageKey).catch(() => undefined);
    publishSession(null);
    sessionEventsBlocked = true;
  }

  async function clearPrimaryLocalSessionForGeneration(generation: number): Promise<void> {
    await enqueuePrimary(generation, async () => {
      if (disposed) return;
      await clearPrimaryLocalSession();
    });
  }

  function beginPrimaryAuthentication(): number {
    const generation = advanceGeneration(false);
    void clearTransientClients();
    return generation;
  }

  async function callPrimaryAuth<T>(
    generation: number,
    call: () => Promise<AdapterResult<T>>,
    onSuccess?: (value: T) => void,
  ): Promise<AdapterResult<T>> {
    try {
      const result = await enqueuePrimary(generation, async () => {
        const authResult = await call();
        if (!authResult.ok) return authResult;
        const session = SessionRecordSchema.safeParse(authResult.value);
        if (session.success && recoveryRevocationUserIds.has(session.data.user.id)) {
          sessionEventsBlocked = true;
          const revoked = await revokeOtherSessions(client, session.data.user.id);
          if (!revoked.ok) {
            await clearPrimaryLocalSession();
            return fail(revoked.error);
          }
        }
        return authResult;
      });
      if (result === undefined) return fail('auth.failed');
      if (!result.ok) return result;
      if (generation !== authGeneration) return fail('auth.failed');
      sessionEventsBlocked = false;
      onSuccess?.(result.value);
      return result;
    } catch (error) {
      return fail(reportFailure(error));
    }
  }

  async function installSecondarySession(
    session: SessionRecord,
    expectedUserId: string,
    expectedGeneration: number,
  ): Promise<AdapterResult<void>> {
    if (expectedGeneration !== authGeneration) return fail('auth.failed');
    const generation = advanceGeneration(true);
    return callPrimaryAuth(
      generation,
      async () => {
        suppressedSessionEvents += 1;
        try {
          const signedOut = await client.auth.signOut({ scope: 'local' });
          if (signedOut.error !== null) {
            await clearPrimaryLocalSession();
            return fail(reportFailure(signedOut.error));
          }
          const installed = await client.auth.setSession({
            access_token: session.access_token,
            refresh_token: session.refresh_token,
          });
          if (installed.error !== null) {
            await clearPrimaryLocalSession();
            return fail(reportFailure(installed.error));
          }
          const installedSession = primarySessionFrom(installed);
          if (installedSession === null || installedSession.user.id !== expectedUserId) {
            await clearPrimaryLocalSession();
            return fail('auth.session_missing');
          }
          return success(undefined);
        } finally {
          suppressedSessionEvents -= 1;
        }
      },
      () => publishSession(session),
    );
  }

  async function completeStepUp(
    secondary: SupabaseClient,
    expectedUserId: string,
    expectedGeneration: number,
  ): Promise<AdapterResult<{ readonly sameUser: boolean }>> {
    const sessionResult = await secondary.auth.getSession();
    const session = primarySessionFrom(sessionResult);
    if (expectedGeneration !== authGeneration) {
      await discardTransient(secondary);
      return fail('auth.failed');
    }
    if (session === null) {
      await discardTransient(secondary);
      return fail('auth.session_missing');
    }
    if (session.user.id !== expectedUserId) {
      await discardTransient(secondary);
      return success({ sameUser: false });
    }

    const installed = await installSecondarySession(session, expectedUserId, expectedGeneration);
    if (!installed.ok) {
      await discardTransient(secondary);
      return installed;
    }
    // The session now belongs to the primary client. Never sign it out through the secondary client.
    return success({ sameUser: true });
  }

  async function refreshPrimarySession(): Promise<AuthResult<void>> {
    const generation = authGeneration;
    try {
      const result = await enqueuePrimary(generation, async () => {
        suppressedSessionEvents += 1;
        try {
          const response = await client.auth.refreshSession();
          if (disposed || generation !== authGeneration) return fail('auth.failed');
          if (response.error !== null) {
            if (isTransientAuthError(response.error)) {
              return fail(reportFailure(response.error));
            }
            sessionEventsBlocked = true;
            await clearPrimaryLocalSession();
            return fail(reportFailure(response.error));
          }
          const refreshed = primarySessionFrom(response);
          if (refreshed === null) {
            sessionEventsBlocked = true;
            await clearPrimaryLocalSession();
            return fail('auth.session_missing');
          }
          sessionEventsBlocked = false;
          publishSession(refreshed);
          return success(undefined);
        } finally {
          suppressedSessionEvents -= 1;
        }
      });
      return result ?? fail('auth.failed');
    } catch (error) {
      return fail(reportFailure(error));
    }
  }

  async function revalidateSession(): Promise<AuthResult<void>> {
    const generation = authGeneration;
    if (disposed) return fail('auth.failed');
    try {
      const result = await enqueuePrimary(generation, async () => {
        suppressedSessionEvents += 1;
        try {
          const response = await client.auth.getSession();
          if (disposed || generation !== authGeneration) return fail('auth.failed');

          if (response.error !== null) {
            if (isTransientAuthError(response.error)) {
              return fail(reportFailure(response.error));
            }
            sessionEventsBlocked = true;
            await clearPrimaryLocalSession();
            return fail(reportFailure(response.error));
          }

          const current = primarySessionFrom(response);
          if (current === null) {
            sessionEventsBlocked = true;
            await clearPrimaryLocalSession();
            return fail('auth.session_missing');
          }

          if (recoveryRevocationUserIds.has(current.user.id)) {
            sessionEventsBlocked = true;
            const revoked = await revokeOtherSessions(client, current.user.id);
            if (disposed || generation !== authGeneration) return fail('auth.failed');
            if (!revoked.ok) {
              await clearPrimaryLocalSession();
              return fail(revoked.error);
            }
          }

          const authMetadata = authMethodFromSession(current);
          const shouldNotify =
            currentSummary?.userId !== current.user.id ||
            currentAuthMethod !== authMetadata.method ||
            recentAuthAt !== authMetadata.recentAuthAt;
          sessionEventsBlocked = false;
          publishSession(current, shouldNotify);
          return success(undefined);
        } finally {
          suppressedSessionEvents -= 1;
        }
      });
      return result ?? fail('auth.failed');
    } catch (error) {
      return fail(reportFailure(error));
    }
  }

  async function getAuthContext(): Promise<{
    readonly accessToken: string | null;
    readonly userId: string | null;
  }> {
    try {
      const result = await client.auth.getSession();
      const session = primarySessionFrom(result);
      return {
        accessToken: session?.access_token ?? null,
        userId: session?.user.id ?? null,
      };
    } catch {
      return { accessToken: null, userId: null };
    }
  }

  async function signOutLocalIfUserMatches(expectedUserId: string): Promise<boolean> {
    const generation = authGeneration;
    const result = await enqueuePrimary(
      generation,
      async () => {
        const current = primarySessionFrom(await client.auth.getSession());
        if (current === null || current.user.id !== expectedUserId) {
          sessionEventsBlocked = false;
          if (current !== null) publishSession(current);
          return { cleared: false, generation: authGeneration };
        }

        const cleanupGeneration = advanceGeneration(true);
        activeMutationGeneration = cleanupGeneration;
        await clearTransientClients();
        suppressedSessionEvents += 1;
        try {
          await client.auth.signOut({ scope: 'local' });
          await storage.removeItem(storageKey).catch(() => undefined);
          publishSession(null);
        } finally {
          suppressedSessionEvents -= 1;
        }
        return { cleared: true, generation: cleanupGeneration };
      },
      (value) => value.generation,
    );
    return result?.cleared ?? false;
  }

  async function previousSessionFromStorage(): Promise<CapturedPreviousSessionPort | null> {
    const generation = authGeneration;
    const previous = sessionFromStorage(await storage.getItem(storageKey));
    if (previous === null) return null;

    const secondary = createTransientClient();
    try {
      const restored = await secondary.auth.setSession({
        access_token: previous.access_token,
        refresh_token: previous.refresh_token,
      });
      if (restored.error !== null || generation !== authGeneration) {
        await discardTransient(secondary);
        return null;
      }
      const restoredSession = primarySessionFrom(restored);
      if (restoredSession === null || restoredSession.user.id !== previous.user.id) {
        await discardTransient(secondary);
        return null;
      }

      return {
        getAccessToken: async () => {
          const result = await secondary.auth.getSession();
          const session = primarySessionFrom(result);
          return session?.user.id === previous.user.id ? session.access_token : null;
        },
        signOutLocal: async () => {
          const result = await secondary.auth.signOut({ scope: 'local' });
          if (result.error !== null) throw new Error('Previous session cleanup failed.');
        },
      };
    } catch {
      await discardTransient(secondary);
      return null;
    }
  }

  const apiSession = {
    getAccessToken: async (): Promise<string | null> => {
      const result = await client.auth.getSession();
      if (result.error !== null) return null;
      const session = primarySessionFrom(result);
      return session?.access_token ?? null;
    },
    refreshSession: async (): Promise<string | null> => {
      const result = await refreshPrimarySession();
      if (!result.ok) return null;
      return apiSession.getAccessToken();
    },
    signOutLocal: async (): Promise<void> => {
      const result = await auth.signOut('local');
      if (!result.ok) throw new Error('Authentication session cleanup failed.');
    },
  };

  const auth: AuthTransportPort = {
    getCurrentAuthMethod: () => currentAuthMethod,
    getPendingPasswordSetup: () => provisionalPurpose,
    isRecentlyAuthenticated(maxAgeSeconds) {
      if (recentAuthAt === null || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) {
        return false;
      }
      return now() / 1000 - recentAuthAt <= maxAgeSeconds;
    },
    async sendEmailCode(input) {
      if (input.purpose !== 'step_up' && provisionalPromotionGeneration !== null) {
        return fail('auth.failed');
      }
      const pendingGeneration = provisionalGeneration;
      const action = input.resend
        ? 'resend'
        : input.purpose === 'sign_up'
          ? 'sign_up'
          : input.purpose === 'step_up'
            ? 'reauth'
            : 'sign_in_otp';
      const target =
        input.purpose === 'step_up' ? (stepUpClient ??= createTransientClient()) : client;
      const result = await captchaCall<void>(action, (captchaToken) =>
        target.auth.signInWithOtp({
          email: input.email,
          options: {
            shouldCreateUser: input.purpose !== 'step_up',
            ...(input.purpose === 'sign_up' ? { data: { locale: input.locale } } : {}),
            ...(captchaToken === undefined ? {} : { captchaToken }),
          },
        }),
      );
      if (!result.ok || input.purpose === 'step_up') return result;
      if (provisionalPromotionGeneration !== null || pendingGeneration !== provisionalGeneration) {
        return fail('auth.failed');
      }
      await clearTransientClients();
      return result;
    },
    async verifyEmailCode(input) {
      if (input.purpose === 'sign_in') {
        const generation = beginPrimaryAuthentication();
        const result = await callPrimaryAuth(
          generation,
          async () => {
            const result = await captchaCall(
              'sign_in_otp',
              (captchaToken) =>
                client.auth.verifyOtp({
                  email: input.email,
                  token: input.code,
                  type: 'email',
                  options: captchaToken === undefined ? {} : { captchaToken },
                }),
              (response) => {
                const error = sdkError(response);
                if (error !== null) return fail(reportFailure(error));
                const session = primarySessionFrom(response);
                return session === null ? fail('auth.session_missing') : success(session);
              },
            );
            if (result.ok) currentAuthMethod = 'email_otp';
            return result;
          },
          (session) => publishSession(session),
        );
        return result.ok ? success(undefined) : result;
      }

      if (provisionalPromotionGeneration !== null) return fail('auth.failed');
      const purpose: PasswordSetupPurpose = input.purpose === 'sign_up' ? 'sign_up' : 'recovery';
      const authGenerationAtStart = authGeneration;
      const pendingGeneration = ++provisionalGeneration;
      const previousProvisional = provisionalClient;
      provisionalClient = null;
      provisionalPurpose = null;
      provisionalUserId = null;
      await discardTransient(previousProvisional);
      if (authGenerationAtStart !== authGeneration || pendingGeneration !== provisionalGeneration) {
        return fail('auth.failed');
      }
      const candidate = createTransientClient();
      provisionalClient = candidate;
      let verifiedUserId: string | null = null;
      const result = await captchaCall(
        purpose === 'sign_up' ? 'sign_up' : 'reset_password',
        (captchaToken) =>
          candidate.auth.verifyOtp({
            email: input.email,
            token: input.code,
            type: purpose === 'sign_up' ? 'email' : 'recovery',
            options: captchaToken === undefined ? {} : { captchaToken },
          }),
        (response) => {
          const error = sdkError(response);
          if (error !== null) return fail(reportFailure(error));
          const session = primarySessionFrom(response);
          if (session === null) return fail('auth.session_missing');
          verifiedUserId = session.user.id;
          return success(undefined);
        },
      );
      if (
        !result.ok ||
        authGenerationAtStart !== authGeneration ||
        pendingGeneration !== provisionalGeneration ||
        provisionalClient !== candidate
      ) {
        if (provisionalClient === candidate && pendingGeneration === provisionalGeneration) {
          provisionalPurpose = null;
          provisionalUserId = null;
          provisionalClient = null;
          provisionalGeneration += 1;
        }
        await discardTransient(candidate);
        return result.ok ? fail('auth.failed') : result;
      }
      provisionalPurpose = purpose;
      provisionalUserId = verifiedUserId;
      return success(undefined);
    },
    async signInWithPassword(input) {
      const generation = beginPrimaryAuthentication();
      const result = await callPrimaryAuth(
        generation,
        async () => {
          const result = await captchaCall(
            'sign_in_password',
            (captchaToken) =>
              client.auth.signInWithPassword({
                email: input.email,
                password: input.password,
                options: captchaToken === undefined ? {} : { captchaToken },
              }),
            (response) => {
              const error = sdkError(response);
              if (error !== null) return fail(reportFailure(error));
              const session = primarySessionFrom(response);
              return session === null ? fail('auth.session_missing') : success(session);
            },
          );
          if (result.ok) currentAuthMethod = 'email_password';
          return result;
        },
        (session) => publishSession(session),
      );
      return result.ok ? success(undefined) : result;
    },
    async sendPasswordResetCode(input) {
      if (provisionalPromotionGeneration !== null) return fail('auth.failed');
      const pendingGeneration = provisionalGeneration;
      const result = await captchaCall<void>('reset_password', (captchaToken) =>
        client.auth.resetPasswordForEmail(
          input.email,
          captchaToken === undefined ? {} : { captchaToken },
        ),
      );
      if (!result.ok) return result;
      if (provisionalPromotionGeneration !== null || pendingGeneration !== provisionalGeneration) {
        return fail('auth.failed');
      }
      await clearTransientClients();
      return result;
    },
    async sendPasswordChangeCode() {
      return mappedCall(() => client.auth.reauthenticate());
    },
    async resendEmailChangeCode(input) {
      return captchaCall('resend', (captchaToken) =>
        client.auth.resend({
          type: 'email_change',
          email: input.email,
          options: captchaToken === undefined ? {} : { captchaToken },
        }),
      );
    },
    async updatePassword(input) {
      const isProvisional = input.purpose === 'setup' || input.purpose === 'recovery';
      const target = isProvisional ? provisionalClient : client;
      if (target === null) return fail('auth.session_missing');
      const expectedAuthGeneration = authGeneration;
      const expectedProvisionalGeneration = provisionalGeneration;
      const expectedPurpose: PasswordSetupPurpose | null =
        input.purpose === 'setup' ? 'sign_up' : input.purpose === 'recovery' ? 'recovery' : null;
      if (
        isProvisional &&
        (provisionalPromotionGeneration !== null ||
          provisionalClient !== target ||
          provisionalPurpose !== expectedPurpose ||
          (input.purpose === 'recovery' && provisionalUserId === null))
      ) {
        return fail('auth.session_missing');
      }
      if (isProvisional) provisionalPromotionGeneration = expectedProvisionalGeneration;

      const provisionalIsCurrent = () =>
        !isProvisional ||
        (provisionalGeneration === expectedProvisionalGeneration &&
          provisionalClient === target &&
          provisionalPurpose === expectedPurpose);

      try {
        if (input.purpose === 'recovery' && provisionalUserId !== null) {
          const marker = await addRecoveryRevocationMarker(provisionalUserId);
          if (!marker.ok) return marker;
        }
        const result = await mappedCall(() =>
          target.auth.updateUser({
            password: input.password,
            ...(input.nonce === undefined ? {} : { nonce: input.nonce }),
          }),
        );
        if (!result.ok) return result;
        if (expectedAuthGeneration !== authGeneration || !provisionalIsCurrent()) {
          return fail('auth.failed');
        }

        if (isProvisional) {
          if (input.purpose === 'recovery') {
            if (provisionalUserId === null) return fail('auth.session_missing');
            const revoked = await revokeOtherSessions(target, provisionalUserId);
            if (!revoked.ok) return revoked;
            if (expectedAuthGeneration !== authGeneration || !provisionalIsCurrent()) {
              return fail('auth.failed');
            }
          }
          const session = primarySessionFrom(await target.auth.getSession());
          if (
            session === null ||
            session.user.id !== provisionalUserId ||
            expectedAuthGeneration !== authGeneration ||
            !provisionalIsCurrent()
          ) {
            return fail('auth.session_missing');
          }
          const installed = await installSecondarySession(
            session,
            session.user.id,
            expectedAuthGeneration,
          );
          if (!installed.ok) {
            if (provisionalIsCurrent()) {
              provisionalClient = null;
              provisionalPurpose = null;
              provisionalUserId = null;
              provisionalGeneration += 1;
              await discardTransient(target);
            }
            return installed;
          }
          if (!provisionalIsCurrent()) return fail('auth.failed');
          // Drop the provisional client reference without signing out the session now owned by primary.
          provisionalClient = null;
          provisionalPurpose = null;
          provisionalUserId = null;
          provisionalGeneration += 1;
        }

        currentAuthMethod = 'email_password';
        return success(undefined);
      } finally {
        if (isProvisional && provisionalPromotionGeneration === expectedProvisionalGeneration) {
          provisionalPromotionGeneration = null;
        }
      }
    },
    async updateLocale(locale: Locale) {
      return mappedCall(() => client.auth.updateUser({ data: { locale } }));
    },
    async beginEmailChange(input) {
      if (!auth.isRecentlyAuthenticated(options.recentAuthMaxAgeSec())) return fail('auth.failed');
      return mappedCall(() => client.auth.updateUser({ email: input.email }));
    },
    async verifyEmailChangeCode(input) {
      return captchaCall('reauth', (captchaToken) =>
        client.auth.verifyOtp({
          email: input.email,
          token: input.code,
          type: 'email_change',
          options: captchaToken === undefined ? {} : { captchaToken },
        }),
      );
    },
    async stepUpWithPassword(input) {
      const expectedGeneration = authGeneration;
      await discardTransient(stepUpClient);
      stepUpClient = null;
      const secondary = createTransientClient();
      const result = await captchaCall(
        'reauth',
        (captchaToken) =>
          secondary.auth.signInWithPassword({
            email: input.email,
            password: input.password,
            options: captchaToken === undefined ? {} : { captchaToken },
          }),
        (response) => {
          const error = sdkError(response);
          if (error !== null) return fail(reportFailure(error));
          return primarySessionFrom(response) === null
            ? fail('auth.session_missing')
            : success(undefined);
        },
      );
      if (!result.ok) {
        await discardTransient(secondary);
        return result;
      }
      if (expectedGeneration !== authGeneration) {
        await discardTransient(secondary);
        return fail('auth.failed');
      }
      return completeStepUp(secondary, input.expectedUserId, expectedGeneration);
    },
    async verifyStepUpCode(input) {
      const secondary = stepUpClient;
      if (secondary === null) return fail('auth.session_missing');
      const expectedGeneration = authGeneration;
      const result = await captchaCall(
        'reauth',
        (captchaToken) =>
          secondary.auth.verifyOtp({
            email: input.email,
            token: input.code,
            type: 'email',
            options: captchaToken === undefined ? {} : { captchaToken },
          }),
        (response) => {
          const error = sdkError(response);
          if (error !== null) return fail(reportFailure(error));
          return primarySessionFrom(response) === null
            ? fail('auth.session_missing')
            : success(undefined);
        },
      );
      if (!result.ok) return result;
      if (expectedGeneration !== authGeneration || stepUpClient !== secondary) {
        if (stepUpClient === secondary) {
          stepUpClient = null;
          await discardTransient(secondary);
        }
        return fail('auth.failed');
      }
      stepUpClient = null;
      return completeStepUp(secondary, input.expectedUserId, expectedGeneration);
    },
    signOut: (scope) => signOut(scope),
  };

  const operations: AuthOperationsPort = {
    signInAnonymously: async (captchaToken) => {
      const generation = beginPrimaryAuthentication();
      const result = await callPrimaryAuth(
        generation,
        async () => {
          const result = await mappedCall(
            () =>
              client.auth.signInAnonymously({
                options: captchaToken === undefined ? {} : { captchaToken },
              }),
            (response) => {
              const error = sdkError(response);
              if (error !== null) return fail(reportFailure(error));
              const session = primarySessionFrom(response);
              return session === null ? fail('auth.session_missing') : success(session);
            },
          );
          return result;
        },
        (session) => publishSession(session),
      );
      return result.ok ? success(undefined) : result;
    },
    signInWithIdToken: async (input: IdentityTokenInput, captchaToken) => {
      const generation = beginPrimaryAuthentication();
      const result = await callPrimaryAuth(
        generation,
        async () => {
          const result = await mappedCall(
            () =>
              client.auth.signInWithIdToken({
                provider: input.provider,
                token: input.token,
                ...(input.nonce === undefined ? {} : { nonce: input.nonce }),
                options: captchaToken === undefined ? {} : { captchaToken },
              }),
            (response) => {
              const error = sdkError(response);
              if (error !== null) return fail(reportFailure(error));
              const session = primarySessionFrom(response);
              return session === null ? fail('auth.session_missing') : success(session);
            },
          );
          return result;
        },
        (session) => publishSession(session),
      );
      return result.ok ? success(undefined) : result;
    },
    linkIdentity: async (input: LinkIdentityInput, captchaToken) => {
      void captchaToken;
      const credentials: SignInWithOAuthCredentials = {
        provider: input.provider as Provider,
        options: { skipBrowserRedirect: true },
      };
      return mappedCall(() => client.auth.linkIdentity(credentials));
    },
    unlinkIdentity: async (input: UnlinkIdentityInput) => {
      if (!auth.isRecentlyAuthenticated(options.recentAuthMaxAgeSec())) return fail('auth.failed');
      const identities = await mappedCall(
        () => client.auth.getUserIdentities(),
        (response) => {
          const error = sdkError(response);
          if (error !== null) return fail(reportFailure(error));
          const data = isObject(response) && isObject(response.data) ? response.data : null;
          const identities = data !== null && Array.isArray(data.identities) ? data.identities : [];
          const match = identities.find(
            (identity): identity is UserIdentity =>
              isObject(identity) &&
              typeof identity.identity_id === 'string' &&
              identity.identity_id === input.identityId,
          );
          return match === undefined ? fail('auth.failed') : success(match);
        },
      );
      if (!identities.ok) return identities;
      return mappedCall(() => client.auth.unlinkIdentity(identities.value));
    },
    updateEmail: async (email) => auth.beginEmailChange({ email }),
    verifyEmailChangeOtp: async (input: EmailChangeOtpInput) =>
      captchaCall('reauth', (captchaToken) =>
        client.auth.verifyOtp({
          email: input.email,
          token: input.token,
          type: 'email_change',
          options: captchaToken === undefined ? {} : { captchaToken },
        }),
      ),
    refreshSession: () => refreshPrimarySession(),
    signOutEverywhere: async () => {
      if (!auth.isRecentlyAuthenticated(options.recentAuthMaxAgeSec())) return fail('auth.failed');
      return signOut('global');
    },
  };

  async function signOut(scope: 'local' | 'global'): Promise<AuthResult<void>> {
    const generation = advanceGeneration(true);
    await clearTransientClients();
    try {
      const result = await enqueuePrimary(generation, async () => {
        const response = await client.auth.signOut({ scope });
        await storage.removeItem(storageKey).catch(() => undefined);
        if (response.error !== null) return fail(reportFailure(response.error));
        return success(undefined);
      });
      if (result === undefined) return fail('auth.failed');
      publishSession(null);
      return result;
    } catch (error) {
      await storage.removeItem(storageKey).catch(() => undefined);
      publishSession(null);
      return fail(reportFailure(error));
    }
  }

  const session: SessionPort = {
    getCurrentAccessToken: async () => apiSession.getAccessToken(),
    getSessionSummary: () => currentSummary,
    revalidate: () => revalidateSession(),
    subscribe(listener) {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    signOutLocal: async () => {
      const result = await signOut('local');
      if (!result.ok) throw new Error('Authentication session cleanup failed.');
    },
    capturePreviousSession: previousSessionFromStorage,
  };

  return {
    auth,
    operations,
    session,
    getAuthContext,
    signOutLocalIfUserMatches,
    async initialize() {
      const generation = authGeneration;
      if (disposed) return;
      await loadRecoveryRevocationMarkers();
      if (disposed || generation !== authGeneration) return;
      authSubscription ??= client.auth.onAuthStateChange((event, session) => {
        observeSessionEvent(event, session);
      }).data.subscription;
      const result = await client.auth.getSession();
      if (disposed || generation !== authGeneration) return;
      const error = sdkError(result);
      const restored = primarySessionFrom(result);
      if (
        error !== null ||
        (isObject(result) &&
          isObject(result.data) &&
          result.data.session !== null &&
          restored === null)
      ) {
        if (error !== null && isTransientAuthError(error)) {
          const stored = sessionFromStorage(await storage.getItem(storageKey));
          if (disposed || generation !== authGeneration) return;
          const expiresAt = stored?.expires_at;
          if (
            stored !== null &&
            typeof expiresAt === 'number' &&
            Number.isFinite(expiresAt) &&
            !recoveryRevocationUserIds.has(stored.user.id)
          ) {
            sessionEventsBlocked = false;
            publishSession(stored);
            offlineSessionSummaryUserId = stored.user.id;
            return;
          }
        }
        await clearPrimaryLocalSessionForGeneration(generation);
        return;
      }
      if (restored !== null) {
        if (recoveryRevocationUserIds.has(restored.user.id)) {
          sessionEventsBlocked = true;
          const revoked = await revokeOtherSessions(client, restored.user.id);
          if (disposed || generation !== authGeneration) return;
          if (!revoked.ok) {
            await clearPrimaryLocalSessionForGeneration(generation);
            return;
          }
        }
        if (disposed || generation !== authGeneration) return;
        sessionEventsBlocked = false;
        publishSession(restored);
      }
    },
    startAutoRefresh: () => client.auth.startAutoRefresh(),
    stopAutoRefresh: () => client.auth.stopAutoRefresh(),
    handleAccountDeleted: (userId) => {
      const currentUserId = currentSummary?.userId ?? null;
      if (
        (currentUserId !== null && currentUserId !== userId) ||
        (provisionalUserId !== null && provisionalUserId !== userId)
      ) {
        return false;
      }
      if (recoveryRevocationUserIds.delete(userId)) {
        void persistRecoveryRevocationMarkers().catch(() => undefined);
      }
      void clearTransientClients();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      advanceGeneration(true);
      client.auth.stopAutoRefresh();
      authSubscription?.unsubscribe();
      void clearTransientClients();
    },
  };
}
