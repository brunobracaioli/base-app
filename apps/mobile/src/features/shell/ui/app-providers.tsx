import NetInfo from '@react-native-community/netinfo';
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
  useQueryClient,
} from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ActivityIndicator, AppState, Platform, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { I18nextProvider } from 'react-i18next';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getLocales } from 'expo-localization';

import product from '@base-app/config/product.config';
import { mobileExtensions } from '../../../extensions';
import {
  installExtensionApi,
  unavailableExtensionApiClient,
  type ExtensionApiDependencies,
} from '../../../composition/extension-api';
import {
  AuthRuntimeProvider,
  createAuthRuntime,
  useOptionalAuthRuntime,
  type AuthRuntimeHandle,
} from '../../../composition/auth-runtime';
import { unavailableAuthOperations, unavailableSessionPort } from '../../auth/model/auth-ports';
import type { AuthOperationsPort, SessionPort } from '../../auth/model/auth-ports';
import type { ApiClient } from '../../../shared/api-client/api-client';
import type { MobileExtension, SessionSummary } from '../../../extensions/types';
import { useAppConfig } from '../../app-config';
import {
  composeMobileExtensions,
  type MobileExtensionRegistry,
} from '../../../extensions/registry';
import {
  resolveLocale,
  createMobileI18n,
  getActiveLocale,
  setActiveMobileI18n,
  translateMobile,
} from '../../../shared/i18n';
import { ThemeProvider } from '../../../shared/theme/theme';
import { OfflineBanner } from './offline-banner';

const ExtensionRegistryContext = createContext<MobileExtensionRegistry | null>(null);
const SessionSummaryContext = createContext<SessionSummary | null>(null);

export type BootShellState = {
  readonly updateRequired: boolean;
  readonly maintenance: boolean;
  readonly termsAccepted: boolean;
  readonly offline: boolean;
  readonly extensionBlock: { readonly href: string } | null;
};

const defaultBootShellState: BootShellState = {
  updateRequired: false,
  maintenance: false,
  termsAccepted: false,
  offline: false,
  extensionBlock: null,
};
const BootShellContext = createContext<BootShellState>(defaultBootShellState);

function getPublicEnvironment(): Record<string, string | undefined> {
  return {
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    EXPO_PUBLIC_REVENUECAT_IOS_KEY: process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY,
    EXPO_PUBLIC_REVENUECAT_ANDROID_KEY: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY,
    EXPO_PUBLIC_SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN,
  };
}

function QueryLifecycleBridge() {
  useEffect(() => {
    focusManager.setEventListener((setFocused) => {
      const subscription = AppState.addEventListener('change', (state) => {
        setFocused(state === 'active');
      });
      return () => subscription.remove();
    });
    onlineManager.setEventListener((setOnline) =>
      NetInfo.addEventListener((state) => setOnline(state.isConnected === true)),
    );
    return () => {
      focusManager.setEventListener(() => () => undefined);
      onlineManager.setEventListener(() => () => undefined);
    };
  }, []);
  return null;
}

function ExtensionProviders({
  components,
  children,
}: React.PropsWithChildren<{ readonly components: MobileExtensionRegistry['providers'] }>) {
  return components.reduceRight<React.ReactNode>(
    (content, Component) => <Component>{content}</Component>,
    children,
  );
}

export type AppProvidersProps = React.PropsWithChildren<{
  readonly extensions?: readonly MobileExtension[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly sessionSummary?: SessionSummary | null;
  readonly authOperations?: AuthOperationsPort;
  readonly sessionPort?: SessionPort;
  readonly apiClient?: ApiClient;
  readonly authRuntime?: AuthRuntimeHandle;
  readonly initialLocale?: 'pt-BR' | 'en' | 'es';
  readonly bootState?: BootShellState;
}>;

export function AppProviders({
  children,
  extensions = mobileExtensions,
  environment,
  sessionSummary = null,
  authOperations = unavailableAuthOperations,
  sessionPort = unavailableSessionPort,
  apiClient = unavailableExtensionApiClient,
  authRuntime,
  initialLocale,
  bootState = defaultBootShellState,
}: AppProvidersProps) {
  const resolvedEnvironment = useMemo(() => environment ?? getPublicEnvironment(), [environment]);
  const registry = useMemo(
    () => composeMobileExtensions(extensions, resolvedEnvironment),
    [extensions, resolvedEnvironment],
  );
  const extensionApiDependencies = useMemo<ExtensionApiDependencies>(
    () => ({
      auth: authRuntime?.operations ?? authOperations,
      session: authRuntime?.session ?? sessionPort,
      apiClient: authRuntime?.apiClient ?? apiClient,
      captchaProvider: registry.captchaProvider,
    }),
    [authOperations, sessionPort, apiClient, authRuntime, registry.captchaProvider],
  );
  useEffect(() => installExtensionApi(extensionApiDependencies), [extensionApiDependencies]);
  const locale =
    initialLocale ??
    resolveLocale(
      undefined,
      getLocales()[0]?.languageTag,
      product.defaultLocale as 'pt-BR' | 'en' | 'es',
    );
  const i18n = useMemo(() => createMobileI18n(locale, registry.i18nNamespaces), [locale, registry]);
  setActiveMobileI18n(i18n);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: false },
          mutations: { retry: false },
        },
      }),
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <ThemeProvider>
              <ExtensionRegistryContext.Provider value={registry}>
                <AuthRuntimeProvider runtime={authRuntime ?? null}>
                  <SessionSummaryContext.Provider value={sessionSummary}>
                    <BootShellContext.Provider value={bootState}>
                      <ExtensionProviders components={registry.providers}>
                        <QueryLifecycleBridge />
                        <OfflineBanner />
                        {children}
                      </ExtensionProviders>
                    </BootShellContext.Provider>
                  </SessionSummaryContext.Provider>
                </AuthRuntimeProvider>
              </ExtensionRegistryContext.Provider>
            </ThemeProvider>
          </I18nextProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export function useMobileExtensionRegistry(): MobileExtensionRegistry {
  const value = useContext(ExtensionRegistryContext);
  if (value === null) {
    throw new Error('AppProviders is missing.');
  }
  return value;
}

export function useAppSessionSummary(): SessionSummary | null {
  const fallback = useContext(SessionSummaryContext);
  const runtime = useOptionalAuthRuntime();
  if (runtime === null) return fallback;
  return runtime.snapshot.accessStatus === 'signed_in' ? runtime.snapshot.session : null;
}

export function useBootShellState(): BootShellState {
  const fallback = useContext(BootShellContext);
  const runtime = useOptionalAuthRuntime();
  if (runtime === null || runtime.snapshot.accessStatus !== 'signed_in') return fallback;
  return {
    ...fallback,
    termsAccepted: runtime.snapshot.me !== null && runtime.snapshot.needsConsent.length === 0,
  };
}

export function AppConfigBootBridge({ children }: React.PropsWithChildren) {
  const current = useBootShellState();
  const appConfig = useAppConfig();
  const bootState = useMemo<BootShellState>(
    () => ({
      ...current,
      updateRequired: appConfig.gate === 'update',
      maintenance: appConfig.gate === 'maintenance',
      offline: appConfig.offline,
    }),
    [appConfig.gate, appConfig.offline, current],
  );

  return <BootShellContext.Provider value={bootState}>{children}</BootShellContext.Provider>;
}

function AuthRuntimeLoadingScreen() {
  const label = translateMobile('loading');
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
      <ActivityIndicator accessibilityLabel={label} />
      <Text accessibilityRole="text">{label}</Text>
    </View>
  );
}

/** Starts Auth only after AppConfigProvider has resolved its remote/cache gate. */
export function AuthRuntimeBootstrap({ children }: React.PropsWithChildren) {
  const appConfig = useAppConfig();
  const registry = useMobileExtensionRegistry();
  const queryClient = useQueryClient();
  const injectedRuntime = useOptionalAuthRuntime();
  const [runtime, setRuntime] = useState<AuthRuntimeHandle | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (injectedRuntime !== null || !appConfig.ready || appConfig.gate !== 'ok') {
      setRuntime(null);
      setFailed(false);
      return;
    }

    let cancelled = false;
    let unregisterExtensionApi: (() => void) | null = null;
    let activeRuntime: AuthRuntimeHandle | null = null;
    let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
    setRuntime(null);
    setFailed(false);

    void createAuthRuntime({
      publicEnv: registry.publicEnv,
      captchaProvider: registry.captchaProvider,
      locale: getActiveLocale,
      clearQueryCache: () => queryClient.clear(),
      initiallyOnline: !appConfig.offline,
    })
      .then((createdRuntime) => {
        activeRuntime = createdRuntime;
        if (cancelled) {
          createdRuntime.dispose?.();
          return;
        }

        unregisterExtensionApi = installExtensionApi({
          auth: createdRuntime.operations,
          session: createdRuntime.session,
          apiClient: createdRuntime.apiClient,
          captchaProvider: registry.captchaProvider,
        });

        const setForeground = (state: string) => {
          if (state === 'active') createdRuntime.startAutoRefresh?.();
          else createdRuntime.stopAutoRefresh?.();
        };
        setForeground(AppState.currentState ?? 'unknown');
        appStateSubscription = AppState.addEventListener('change', setForeground);
        setRuntime(createdRuntime);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      appStateSubscription?.remove();
      activeRuntime?.stopAutoRefresh?.();
      unregisterExtensionApi?.();
      activeRuntime?.dispose?.();
    };
  }, [
    appConfig.gate,
    appConfig.ready,
    injectedRuntime,
    queryClient,
    registry.captchaProvider,
    registry.publicEnv,
  ]);

  const activeController = runtime?.controller ?? injectedRuntime?.controller ?? null;
  const runtimeSessionRevisionRef = useRef(0);
  const [runtimeSessionRevision, setRuntimeSessionRevision] = useState(0);
  useEffect(
    () =>
      runtime?.session.subscribe(() => {
        runtimeSessionRevisionRef.current += 1;
        setRuntimeSessionRevision(runtimeSessionRevisionRef.current);
      }),
    [runtime],
  );
  const sessionRevision =
    runtime === null ? (injectedRuntime?.sessionRevision ?? 0) : runtimeSessionRevision;
  const getSessionRevision = useMemo(
    () =>
      runtime === null
        ? (injectedRuntime?.getSessionRevision ?? (() => 0))
        : () => runtimeSessionRevisionRef.current,
    [runtime, injectedRuntime?.getSessionRevision],
  );
  const sessionRevalidationAvailable =
    runtime?.session.revalidate !== undefined ||
    injectedRuntime?.sessionRevalidationAvailable === true;
  const offlineRevalidationPending = useRef(false);
  const wasOffline = useRef(appConfig.offline);
  const offlineCycle = useRef(0);
  const profileRefreshInFlight = useRef(false);
  const inFlightAttemptKey = useRef<string | null>(null);
  const inFlightOfflineCycle = useRef(0);
  const lastAttemptKey = useRef<string | null>(null);
  const retryAfterFlight = useRef(false);
  const [revalidationRetryEpoch, setRevalidationRetryEpoch] = useState(0);
  const revalidationRetryEpochRef = useRef(revalidationRetryEpoch);
  revalidationRetryEpochRef.current = revalidationRetryEpoch;
  const authSnapshot = activeController?.getSnapshot() ?? null;
  const authStatus = authSnapshot?.accessStatus ?? null;
  const authUserId = authSnapshot?.session?.userId ?? null;
  const authIsBusy = authSnapshot?.isBusy ?? false;
  const authProfileIsUnknown = authSnapshot?.me === null;
  useEffect(() => {
    if (appConfig.offline) {
      offlineRevalidationPending.current = true;
      wasOffline.current = true;
      return;
    }
    if (wasOffline.current) {
      wasOffline.current = false;
      offlineCycle.current += 1;
      offlineRevalidationPending.current = true;
    }
    if (sessionRevalidationAvailable && authStatus === 'signed_in' && authProfileIsUnknown) {
      offlineRevalidationPending.current = true;
    }
    if (!offlineRevalidationPending.current || activeController === null) return;
    if (authStatus !== 'signed_in' || authUserId === null) {
      if (authStatus === 'signed_out') offlineRevalidationPending.current = false;
      return;
    }
    if (authIsBusy) return;
    const attemptKey = `${authUserId}:${sessionRevision}:${offlineCycle.current}:${revalidationRetryEpoch}`;
    if (profileRefreshInFlight.current) {
      if (inFlightAttemptKey.current !== attemptKey) {
        retryAfterFlight.current = true;
      }
      return;
    }
    if (lastAttemptKey.current === attemptKey) return;

    const expectedUserId = authUserId;
    lastAttemptKey.current = attemptKey;
    profileRefreshInFlight.current = true;
    inFlightAttemptKey.current = attemptKey;
    inFlightOfflineCycle.current = offlineCycle.current;
    void (async () => {
      try {
        const result = await activeController.refreshMe();
        const current = activeController.getSnapshot();
        if (
          result.ok &&
          current.accessStatus === 'signed_in' &&
          current.session?.userId === expectedUserId
        ) {
          offlineRevalidationPending.current = false;
        } else if (current.accessStatus === 'signed_out') {
          offlineRevalidationPending.current = false;
        }
      } catch {
        // A transient refresh failure leaves the offline summary visible; do not send /me yet.
      } finally {
        const current = activeController.getSnapshot();
        const currentUserId =
          current.accessStatus === 'signed_in' ? (current.session?.userId ?? null) : null;
        const networkCycleChanged = offlineCycle.current !== inFlightOfflineCycle.current;
        const userChanged = currentUserId !== expectedUserId;
        const currentSessionRevision = getSessionRevision();
        profileRefreshInFlight.current = false;
        inFlightAttemptKey.current = null;
        if (current.accessStatus === 'signed_out') {
          offlineRevalidationPending.current = false;
        } else if (!networkCycleChanged && !userChanged && currentUserId !== null) {
          lastAttemptKey.current = `${currentUserId}:${currentSessionRevision}:${offlineCycle.current}:${revalidationRetryEpochRef.current}`;
        }
        if (retryAfterFlight.current && (networkCycleChanged || userChanged)) {
          retryAfterFlight.current = false;
          setRevalidationRetryEpoch((epoch) => epoch + 1);
        } else {
          retryAfterFlight.current = false;
        }
      }
    })();
  }, [
    appConfig.offline,
    activeController,
    authIsBusy,
    authProfileIsUnknown,
    authStatus,
    authUserId,
    revalidationRetryEpoch,
    getSessionRevision,
    sessionRevision,
    sessionRevalidationAvailable,
  ]);

  if (injectedRuntime !== null) return <>{children}</>;
  if (appConfig.ready && appConfig.gate !== 'ok') return <>{children}</>;
  if (failed) throw new Error('Authentication initialization failed.');
  if (runtime === null) return <AuthRuntimeLoadingScreen />;
  return <AuthRuntimeProvider runtime={runtime}>{children}</AuthRuntimeProvider>;
}

export function nativePlatform(): 'ios' | 'android' {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    throw new Error('The mobile API client is unavailable on this platform.');
  }
  return Platform.OS;
}
