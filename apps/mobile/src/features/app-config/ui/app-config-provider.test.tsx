import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { AppState, Pressable, Text, type AppStateStatus } from 'react-native';

import type { AppConfigResponseValue } from '@base-app/contracts';
import type { AppConfigCache } from '../adapters/app-config-cache';
import type { AppConfigReader } from '../api/app-config-reader';
import { AppConfigProvider, useAppConfig } from './app-config-provider';

function makeConfig(
  input: {
    readonly minSupported?: string;
    readonly maintenanceActive?: boolean;
    readonly termsVersion?: string;
  } = {},
): AppConfigResponseValue {
  const minSupported = input.minSupported ?? '0.0.0';
  return {
    versions: {
      ios: {
        minSupported,
        latest: '2.0.0',
        storeUrl: 'https://apps.apple.com/app/id0000000000',
      },
      android: {
        minSupported,
        latest: '2.0.0',
        storeUrl: 'https://play.google.com/store/apps/details?id=com.example.myapp',
      },
    },
    maintenance: {
      active: input.maintenanceActive ?? false,
      platforms: ['ios', 'android'],
      messageKey: 'maintenance.default',
      until: null,
    },
    legal: {
      termsVersion: input.termsVersion ?? '2026-01-01',
      privacyVersion: '2026-01-01',
      termsUrl: 'https://myapp.example.invalid/terms',
      privacyUrl: 'https://myapp.example.invalid/privacy',
    },
  };
}

function makeCache(config: AppConfigResponseValue | null): AppConfigCache {
  return {
    read: jest.fn(async () => config),
    write: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function AppConfigProbe() {
  const appConfig = useAppConfig();
  return (
    <>
      <Text testID="app-config-state">
        {`${appConfig.gate}/${appConfig.source}/${String(appConfig.offline)}/${String(appConfig.ready)}`}
      </Text>
      <Text testID="terms-version">{appConfig.config.legal.termsVersion}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Refresh config"
        onPress={() => void appConfig.refresh()}
      >
        <Text>Refresh</Text>
      </Pressable>
    </>
  );
}

function appConfigTree(props: React.ComponentProps<typeof AppConfigProvider>) {
  return (
    <AppConfigProvider {...props}>
      <AppConfigProbe />
    </AppConfigProvider>
  );
}

function renderAppConfig(props: React.ComponentProps<typeof AppConfigProvider>) {
  return render(appConfigTree(props));
}

async function flushProviderEffects(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

let appStateListeners: Array<(state: AppStateStatus) => void> = [];

beforeEach(() => {
  appStateListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_eventType, listener) => {
    appStateListeners.push(listener as (state: AppStateStatus) => void);
    return { remove: jest.fn() } as ReturnType<typeof AppState.addEventListener>;
  });
});

describe('AppConfigProvider', () => {
  it('uses safe defaults on a cold offline start when there is no cache', async () => {
    const cache = makeCache(null);
    const reader = jest.fn<ReturnType<AppConfigReader>, Parameters<AppConfigReader>>();
    const view = await renderAppConfig({
      cache,
      reader,
      appVersion: '1.0.0',
      platform: 'ios',
      onlineOverride: false,
      foregroundOverride: true,
    });
    await flushProviderEffects();
    expect(view.getByText('ok/default/true/true')).toBeTruthy();
    expect(view.getByText('2026-01-01')).toBeTruthy();
    expect(reader).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('applies cached update offline but ignores cached maintenance while offline', async () => {
    const updateCache = makeCache(makeConfig({ minSupported: '2.0.0' }));
    const updateView = await renderAppConfig({
      cache: updateCache,
      reader: jest.fn<ReturnType<AppConfigReader>, Parameters<AppConfigReader>>(),
      appVersion: '1.0.0',
      platform: 'ios',
      onlineOverride: false,
      foregroundOverride: true,
    });
    await flushProviderEffects();
    expect(updateView.getByText('update/cache/true/true')).toBeTruthy();

    await updateView.unmount();
    const maintenanceCache = makeCache(makeConfig({ maintenanceActive: true }));
    const maintenanceView = await renderAppConfig({
      cache: maintenanceCache,
      reader: jest.fn<ReturnType<AppConfigReader>, Parameters<AppConfigReader>>(),
      appVersion: '1.0.0',
      platform: 'ios',
      onlineOverride: false,
      foregroundOverride: true,
    });
    await flushProviderEffects();
    expect(maintenanceView.getByText('ok/cache/true/true')).toBeTruthy();
    await maintenanceView.unmount();
  });

  it('recovers from a cached maintenance gate after connectivity returns and fresh config is read', async () => {
    const cache = makeCache(makeConfig({ maintenanceActive: true }));
    const remote = deferred<AppConfigResponseValue>();
    const reader: AppConfigReader = jest.fn().mockReturnValue(remote.promise);
    const result = await renderAppConfig({
      cache,
      reader,
      appVersion: '1.0.0',
      platform: 'ios',
      onlineOverride: false,
      foregroundOverride: true,
    });
    await flushProviderEffects();
    expect(result.getByText('ok/cache/true/true')).toBeTruthy();

    await result.rerender(
      appConfigTree({
        cache,
        reader,
        appVersion: '1.0.0',
        platform: 'ios',
        onlineOverride: true,
        foregroundOverride: true,
      }),
    );

    await flushProviderEffects();
    expect(reader).toHaveBeenCalledTimes(1);
    await act(async () => {
      remote.resolve(makeConfig());
      await remote.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    await flushProviderEffects();
    expect(result.getByText('ok/remote/false/true')).toBeTruthy();
    expect(reader).toHaveBeenCalledTimes(1);
    await result.unmount();
  });

  it('ignores an older request that resolves after a newer refresh', async () => {
    let resolveFirst!: (config: AppConfigResponseValue) => void;
    let resolveSecond!: (config: AppConfigResponseValue) => void;
    const first = new Promise<AppConfigResponseValue>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<AppConfigResponseValue>((resolve) => {
      resolveSecond = resolve;
    });
    const reader: AppConfigReader = jest
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const cache = makeCache(null);
    const result = await renderAppConfig({
      cache,
      reader,
      appVersion: '1.0.0',
      platform: 'ios',
      onlineOverride: false,
      foregroundOverride: true,
    });
    await flushProviderEffects();
    expect(result.getByText('ok/default/true/true')).toBeTruthy();

    await result.rerender(
      appConfigTree({
        cache,
        reader,
        appVersion: '1.0.0',
        platform: 'ios',
        onlineOverride: true,
        foregroundOverride: true,
      }),
    );
    await flushProviderEffects();
    await fireEvent.press(result.getByRole('button', { name: 'Refresh config' }));

    await act(async () => {
      resolveSecond(makeConfig({ minSupported: '2.0.0', termsVersion: '2026-02-01' }));
      await second;
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushProviderEffects();
    expect(result.getByText('update/remote/false/true')).toBeTruthy();
    expect(result.getByText('2026-02-01')).toBeTruthy();

    await act(async () => {
      resolveFirst(makeConfig({ termsVersion: '2026-01-15' }));
      await first;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.getByText('update/remote/false/true')).toBeTruthy();
    expect(result.getByText('2026-02-01')).toBeTruthy();
    expect(cache.write).toHaveBeenCalledTimes(1);
    await result.unmount();
  });

  it('polls a live maintenance gate again after sixty seconds', async () => {
    const remote = deferred<AppConfigResponseValue>();
    try {
      const maintenance = makeConfig({ maintenanceActive: true });
      const reader: AppConfigReader = jest
        .fn()
        .mockReturnValueOnce(remote.promise)
        .mockResolvedValue(maintenance);
      const cache = makeCache(null);
      const view = await renderAppConfig({
        cache,
        reader,
        appVersion: '1.0.0',
        platform: 'ios',
        onlineOverride: true,
        foregroundOverride: false,
      });
      await flushProviderEffects();

      await act(async () => {
        remote.resolve(maintenance);
        await remote.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
      await flushProviderEffects();
      expect(view.getByText('maintenance/remote/false/true')).toBeTruthy();
      expect(reader).toHaveBeenCalledTimes(1);

      jest.useFakeTimers();
      await view.rerender(
        appConfigTree({
          cache,
          reader,
          appVersion: '1.0.0',
          platform: 'ios',
          onlineOverride: true,
          foregroundOverride: true,
        }),
      );
      await act(async () => {
        await jest.advanceTimersByTimeAsync(60_000);
      });
      expect(reader).toHaveBeenCalledTimes(2);
      await view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it('refreshes configuration when the app returns to the foreground', async () => {
    const reader: AppConfigReader = jest.fn().mockResolvedValue(makeConfig());
    const view = await renderAppConfig({
      cache: makeCache(null),
      reader,
      appVersion: '1.0.0',
      platform: 'ios',
      onlineOverride: true,
    });
    await flushProviderEffects();
    expect(reader).toHaveBeenCalledTimes(1);
    const providerListener = appStateListeners.at(-1);
    expect(providerListener).toBeDefined();

    await act(async () => providerListener?.('background'));
    expect(reader).toHaveBeenCalledTimes(1);
    await act(async () => providerListener?.('active'));
    await flushProviderEffects();
    expect(reader).toHaveBeenCalledTimes(2);
    await view.unmount();
  });

  it('does not persist a response that resolves after unmount', async () => {
    let resolve!: (config: AppConfigResponseValue) => void;
    const pending = new Promise<AppConfigResponseValue>((complete) => {
      resolve = complete;
    });
    const reader: AppConfigReader = jest.fn().mockReturnValue(pending);
    const cache = makeCache(null);
    const view = await renderAppConfig({
      cache,
      reader,
      appVersion: '1.0.0',
      platform: 'ios',
      onlineOverride: true,
      foregroundOverride: true,
    });
    await flushProviderEffects();
    await view.unmount();
    await act(async () => {
      resolve(makeConfig());
      await pending;
    });
    expect(cache.write).not.toHaveBeenCalled();
  });
});
