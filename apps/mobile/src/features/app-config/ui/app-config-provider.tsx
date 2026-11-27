import { useNetInfo } from '@react-native-community/netinfo';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ActivityIndicator, AppState, Platform, Text, View } from 'react-native';

import type { AppConfigResponseValue, PlatformValue } from '@base-app/contracts';
import { subscribeApiAppGates } from '../../../shared/api-client';
import { translateMobile } from '../../../shared/i18n';
import { resolveAppVersion } from '../../../shared/runtime/app-runtime';
import { createDefaultAppConfig } from '../model/default-app-config';
import { evaluateGate, type AppConfigGate } from '../model/evaluate-gate';
import { readAppConfig, type AppConfigReader } from '../api/app-config-reader';
import { appConfigCache, type AppConfigCache } from '../adapters/app-config-cache';

export type AppConfigSource = 'default' | 'cache' | 'remote';

export type AppConfigContextValue = {
  readonly config: AppConfigResponseValue;
  readonly source: AppConfigSource;
  readonly ready: boolean;
  readonly offline: boolean;
  readonly gate: AppConfigGate;
  refresh(): Promise<void>;
};

export type AppConfigProviderProps = React.PropsWithChildren<{
  readonly reader?: AppConfigReader;
  readonly cache?: AppConfigCache;
  readonly appVersion?: string;
  readonly platform?: PlatformValue;
  readonly onlineOverride?: boolean;
  readonly foregroundOverride?: boolean;
}>;

const AppConfigContext = createContext<AppConfigContextValue | null>(null);
const safeDefaultConfig = createDefaultAppConfig();

function resolveNativePlatform(): PlatformValue {
  if (Platform.OS === 'ios' || Platform.OS === 'android') return Platform.OS;
  throw new Error('App configuration is only available on iOS and Android.');
}

function AppConfigLoadingScreen() {
  const label = translateMobile('loading');
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
      <ActivityIndicator accessibilityLabel={label} />
      <Text accessibilityRole="text">{label}</Text>
    </View>
  );
}

export function AppConfigProvider({
  children,
  reader = readAppConfig,
  cache = appConfigCache,
  appVersion = resolveAppVersion(),
  platform = resolveNativePlatform(),
  onlineOverride,
  foregroundOverride,
}: AppConfigProviderProps) {
  const network = useNetInfo();
  const isOnline = onlineOverride ?? network.isConnected !== false;
  const isOffline = onlineOverride === undefined ? network.isConnected === false : !onlineOverride;
  const [nativeForeground, setNativeForeground] = useState(AppState.currentState === 'active');
  const isForeground = foregroundOverride ?? nativeForeground;
  const [storedConfig, setStoredConfig] = useState<{
    readonly config: AppConfigResponseValue;
    readonly source: AppConfigSource;
    readonly ready: boolean;
  }>({ config: safeDefaultConfig, source: 'default', ready: false });
  const [apiGate, setApiGate] = useState<AppConfigGate | null>(null);
  const mounted = useRef(false);
  const initialized = useRef(false);
  const requestSequence = useRef(0);
  const apiGateSequence = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const onlineRef = useRef(isOnline);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  onlineRef.current = isOnline;

  const refresh = useCallback(async (): Promise<void> => {
    if (!onlineRef.current) {
      if (mounted.current) {
        setStoredConfig((current) => ({ ...current, ready: true }));
      }
      return;
    }

    requestSequence.current += 1;
    const requestId = requestSequence.current;
    const gateSequenceAtStart = apiGateSequence.current;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;

    try {
      const config = await reader(controller.signal);
      if (!mounted.current || requestId !== requestSequence.current) return;
      setStoredConfig({ config, source: 'remote', ready: true });
      if (gateSequenceAtStart === apiGateSequence.current) setApiGate(null);
      void cache.write(config).catch(() => undefined);
    } catch {
      if (!mounted.current || requestId !== requestSequence.current) return;
      setStoredConfig((current) => ({ ...current, ready: true }));
    } finally {
      if (requestId === requestSequence.current) activeController.current = null;
    }
  }, [cache, reader]);
  refreshRef.current = refresh;

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void (async () => {
      const cached = await cache.read().catch(() => null);
      if (cancelled || !mounted.current) return;
      if (cached !== null) {
        setStoredConfig({ config: cached, source: 'cache', ready: !onlineRef.current });
      }

      if (onlineRef.current) {
        initialized.current = true;
        await refreshRef.current();
      } else {
        initialized.current = true;
        setStoredConfig((current) => ({ ...current, ready: true }));
      }
    })();

    return () => {
      cancelled = true;
      mounted.current = false;
      requestSequence.current += 1;
      activeController.current?.abort();
      activeController.current = null;
    };
  }, [cache]);

  useEffect(
    () =>
      subscribeApiAppGates((gate) => {
        apiGateSequence.current += 1;
        setApiGate(gate);
      }),
    [],
  );

  const previousOnline = useRef(isOnline);
  useEffect(() => {
    if (initialized.current && !previousOnline.current && isOnline) {
      void refresh();
    }
    previousOnline.current = isOnline;
  }, [isOnline, refresh]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setNativeForeground(state === 'active');
      if (state === 'active' && onlineRef.current && initialized.current) {
        void refreshRef.current();
      }
    });
    return () => subscription.remove();
  }, []);

  const configGate = evaluateGate(storedConfig.config, {
    appVersion,
    platform,
    offline: isOffline,
  });
  const gate: AppConfigGate =
    configGate === 'update' || apiGate === 'update'
      ? 'update'
      : !isOffline && (configGate === 'maintenance' || apiGate === 'maintenance')
        ? 'maintenance'
        : 'ok';

  useEffect(() => {
    if (!storedConfig.ready || !isOnline || !isForeground) return;
    const timer = setInterval(() => {
      void refreshRef.current();
    }, 60_000);
    return () => clearInterval(timer);
  }, [isForeground, isOnline, storedConfig.ready]);

  const value = useMemo<AppConfigContextValue>(
    () => ({
      config: storedConfig.config,
      source: storedConfig.source,
      ready: storedConfig.ready,
      offline: isOffline,
      gate,
      refresh,
    }),
    [gate, isOffline, refresh, storedConfig],
  );

  return (
    <AppConfigContext.Provider value={value}>
      {storedConfig.ready ? children : <AppConfigLoadingScreen />}
    </AppConfigContext.Provider>
  );
}

export function useAppConfig(): AppConfigContextValue {
  const value = useContext(AppConfigContext);
  if (value === null) throw new Error('AppConfigProvider is missing.');
  return value;
}

export { resolveNativePlatform };
