import NetInfo from '@react-native-community/netinfo';
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AppState, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { I18nextProvider } from 'react-i18next';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getLocales } from 'expo-localization';

import product from '@base-app/config/product.config';
import { mobileExtensions } from '../../../extensions';
import {
  installExtensionApi,
  unavailableExtensionApiClient,
  type ExtensionApiDependencies,
} from '../../../composition/extension-api';
import { unavailableAuthOperations, unavailableSessionPort } from '../../auth/model/auth-ports';
import type { AuthOperationsPort, SessionPort } from '../../auth/model/auth-ports';
import type { ApiClient } from '../../../shared/api-client/api-client';
import type { MobileExtension, SessionSummary } from '../../../extensions/types';
import { useAppConfig } from '../../app-config';
import {
  composeMobileExtensions,
  type MobileExtensionRegistry,
} from '../../../extensions/registry';
import { resolveLocale, createMobileI18n, setActiveMobileI18n } from '../../../shared/i18n';
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
      auth: authOperations,
      session: sessionPort,
      apiClient,
      captchaProvider: registry.captchaProvider,
    }),
    [authOperations, sessionPort, apiClient, registry.captchaProvider],
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
                <SessionSummaryContext.Provider value={sessionSummary}>
                  <BootShellContext.Provider value={bootState}>
                    <ExtensionProviders components={registry.providers}>
                      <QueryLifecycleBridge />
                      <OfflineBanner />
                      {children}
                    </ExtensionProviders>
                  </BootShellContext.Provider>
                </SessionSummaryContext.Provider>
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
  return useContext(SessionSummaryContext);
}

export function useBootShellState(): BootShellState {
  return useContext(BootShellContext);
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

export function nativePlatform(): 'ios' | 'android' {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    throw new Error('The mobile API client is unavailable on this platform.');
  }
  return Platform.OS;
}
