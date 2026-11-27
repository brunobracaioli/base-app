import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { PropsWithChildren } from 'react';

import product from '@base-app/config/product.config';
import type { ApiClient } from '../shared/api-client';
import { apiClient as sharedApiClient, installApiSession } from '../shared/api-client';
import type {
  AccountApiPort,
  AuthController,
  AuthControllerDependencies,
  AuthSnapshot,
  AuthTransportPort,
  IdentityLifecycleSink,
} from '../features/auth';
import { createAuthController, createSupabaseAuthAdapter } from '../features/auth';
import {
  unavailableAuthOperations,
  unavailableSessionPort,
} from '../features/auth/model/auth-ports';
import type { AuthOperationsPort, SessionPort } from '../features/auth/model/auth-ports';
import type { CaptchaProvider, Locale } from '../extensions/types';
import type { MobilePublicEnv } from '../extensions/registry';
import { createAccountApi as createAuthAccountApi } from '../features/auth';
import type { ApiSessionPort } from '../shared/api-client';
import { getActiveLocale } from '../shared/i18n';

export type AuthRuntimeHandle = {
  readonly controller: AuthController;
  readonly auth: AuthTransportPort;
  readonly operations: AuthOperationsPort;
  readonly session: SessionPort;
  readonly account: AccountApiPort;
  readonly apiClient: ApiClient;
  initialize?(): Promise<void>;
  startAutoRefresh?(): void;
  stopAutoRefresh?(): void;
  dispose?(): void;
};

export type CreateAuthRuntimeOptions = {
  readonly publicEnv: MobilePublicEnv;
  readonly captchaProvider: CaptchaProvider | null;
  readonly locale?: () => Locale;
  readonly clearQueryCache?: () => void;
  readonly initiallyOnline?: boolean;
};

export type AuthRuntimeValue = {
  readonly controller: AuthController;
  readonly snapshot: AuthSnapshot;
  readonly sessionRevision: number;
  readonly sessionRevalidationAvailable: boolean;
  readonly getSessionRevision: () => number;
};

export const EMPTY_AUTH_SNAPSHOT: AuthSnapshot = {
  accessStatus: 'signed_out',
  session: null,
  authMethod: null,
  flow: { kind: 'idle' },
  isBusy: false,
  error: null,
  me: null,
  needsConsent: [],
  resendSecondsRemaining: 0,
};

const subscribeNothing = (): (() => void) => () => undefined;
const getEmptySnapshot = (): AuthSnapshot => EMPTY_AUTH_SNAPSHOT;

export const AuthRuntimeContext = createContext<AuthRuntimeValue | null>(null);

export function AuthRuntimeProvider({
  runtime,
  children,
}: PropsWithChildren<{ readonly runtime: AuthRuntimeHandle | null }>) {
  const snapshot = useAuthRuntimeSnapshot(runtime?.controller ?? null);
  const sessionRevisionRef = useRef(0);
  const [sessionRevision, setSessionRevision] = useState(0);
  const getSessionRevision = useMemo(() => () => sessionRevisionRef.current, []);
  useEffect(
    () =>
      runtime?.session.subscribe(() => {
        sessionRevisionRef.current += 1;
        setSessionRevision(sessionRevisionRef.current);
      }),
    [runtime],
  );
  const value = useMemo<AuthRuntimeValue | null>(
    () =>
      runtime === null
        ? null
        : {
            controller: runtime.controller,
            snapshot,
            sessionRevision,
            sessionRevalidationAvailable: runtime.session.revalidate !== undefined,
            getSessionRevision,
          },
    [getSessionRevision, runtime, sessionRevision, snapshot],
  );
  return <AuthRuntimeContext.Provider value={value}>{children}</AuthRuntimeContext.Provider>;
}

export function useAuthRuntimeSnapshot(controller: AuthController | null): AuthSnapshot {
  const subscribe = useMemo(
    () => (controller === null ? subscribeNothing : controller.subscribe.bind(controller)),
    [controller],
  );
  const getSnapshot = useMemo(
    () => (controller === null ? getEmptySnapshot : controller.getSnapshot.bind(controller)),
    [controller],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useOptionalAuthRuntime(): AuthRuntimeValue | null {
  return useContext(AuthRuntimeContext);
}

export function useAuthRuntime(): AuthRuntimeValue {
  const value = useOptionalAuthRuntime();
  if (value === null) {
    throw new Error('Authentication is not ready.');
  }
  return value;
}

const unavailableAuth: AuthTransportPort = {
  getCurrentAuthMethod: () => null,
  getPendingPasswordSetup: () => null,
  isRecentlyAuthenticated: () => false,
  sendEmailCode: async () => ({ ok: false, error: 'auth.unavailable' }),
  verifyEmailCode: async () => ({ ok: false, error: 'auth.unavailable' }),
  signInWithPassword: async () => ({ ok: false, error: 'auth.unavailable' }),
  sendPasswordResetCode: async () => ({ ok: false, error: 'auth.unavailable' }),
  sendPasswordChangeCode: async () => ({ ok: false, error: 'auth.unavailable' }),
  resendEmailChangeCode: async () => ({ ok: false, error: 'auth.unavailable' }),
  updatePassword: async () => ({ ok: false, error: 'auth.unavailable' }),
  updateLocale: async () => ({ ok: false, error: 'auth.unavailable' }),
  beginEmailChange: async () => ({ ok: false, error: 'auth.unavailable' }),
  verifyEmailChangeCode: async () => ({ ok: false, error: 'auth.unavailable' }),
  stepUpWithPassword: async () => ({ ok: false, error: 'auth.unavailable' }),
  verifyStepUpCode: async () => ({ ok: false, error: 'auth.unavailable' }),
  signOut: async () => ({ ok: false, error: 'auth.unavailable' }),
};

function createUnavailableRuntime(options: CreateAuthRuntimeOptions): AuthRuntimeHandle {
  const account = createAuthAccountApi(sharedApiClient);
  const dependencies: AuthControllerDependencies = {
    auth: unavailableAuth,
    account,
    session: unavailableSessionPort,
    now: Date.now,
    locale: options.locale ?? getActiveLocale,
    recentAuthMaxAgeSec: () => product.auth.recentAuthMaxAgeSec,
    lifecycle: {
      onSignedIn: () => undefined,
      onSignedOut: () => options.clearQueryCache?.(),
    },
  };
  return {
    controller: createAuthController(dependencies),
    auth: unavailableAuth,
    operations: unavailableAuthOperations,
    session: unavailableSessionPort,
    account,
    apiClient: sharedApiClient,
  };
}

export async function createAuthRuntime(
  options: CreateAuthRuntimeOptions,
): Promise<AuthRuntimeHandle> {
  const supabaseUrl = options.publicEnv.EXPO_PUBLIC_SUPABASE_URL;
  const publishableKey = options.publicEnv.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const apiUrl = options.publicEnv.EXPO_PUBLIC_API_URL;
  if (supabaseUrl === undefined || publishableKey === undefined || apiUrl === undefined) {
    return createUnavailableRuntime(options);
  }

  let adapter: ReturnType<typeof createSupabaseAuthAdapter> | null = null;
  let uninstallApiSession: (() => void) | null = null;
  let controller: AuthController | null = null;
  try {
    const createdAdapter = createSupabaseAuthAdapter({
      supabaseUrl,
      publishableKey,
      captchaProvider: options.captchaProvider,
      recentAuthMaxAgeSec: () => product.auth.recentAuthMaxAgeSec,
    });
    adapter = createdAdapter;
    const apiSession: ApiSessionPort = {
      getAccessToken: () => createdAdapter.session.getCurrentAccessToken(),
      getAuthContext: () => createdAdapter.getAuthContext(),
      signOutLocalIfUserMatches: (userId) => createdAdapter.signOutLocalIfUserMatches(userId),
      refreshSession: async () => {
        const refreshed = await createdAdapter.operations.refreshSession();
        return refreshed.ok ? createdAdapter.session.getCurrentAccessToken() : null;
      },
      signOutLocal: async () => {
        await createdAdapter.session.signOutLocal();
      },
    };
    uninstallApiSession = installApiSession(apiSession, async (userId) => {
      if (userId !== null && createdAdapter.handleAccountDeleted(userId)) {
        options.clearQueryCache?.();
      }
    });
    const account = createAuthAccountApi(sharedApiClient);
    await createdAdapter.initialize();
    const dependencies: AuthControllerDependencies = {
      auth: createdAdapter.auth,
      account,
      session: createdAdapter.session,
      now: Date.now,
      locale: options.locale ?? getActiveLocale,
      recentAuthMaxAgeSec: () => product.auth.recentAuthMaxAgeSec,
      lifecycle: {
        onSignedIn: () => undefined,
        onSignedOut: () => options.clearQueryCache?.(),
      } satisfies IdentityLifecycleSink,
    };
    controller = createAuthController(dependencies);
    if (
      options.initiallyOnline !== false &&
      createdAdapter.session.getSessionSummary() !== null &&
      createdAdapter.auth.getPendingPasswordSetup() === null
    ) {
      await controller.refreshMe();
    }

    const runtime: AuthRuntimeHandle = {
      controller,
      auth: createdAdapter.auth,
      operations: createdAdapter.operations,
      session: createdAdapter.session,
      account,
      apiClient: sharedApiClient,
      startAutoRefresh: () => createdAdapter.startAutoRefresh(),
      stopAutoRefresh: () => createdAdapter.stopAutoRefresh(),
      dispose: () => {
        controller?.dispose();
        createdAdapter.dispose();
        uninstallApiSession?.();
      },
    };
    return runtime;
  } catch {
    controller?.dispose();
    adapter?.dispose();
    uninstallApiSession?.();
    return createUnavailableRuntime(options);
  }
}
