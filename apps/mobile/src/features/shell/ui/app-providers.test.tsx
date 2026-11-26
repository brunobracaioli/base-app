import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useTranslation } from 'react-i18next';
import { AppState, Text } from 'react-native';
import {
  AppConfigBootBridge,
  AppProviders,
  useBootShellState,
  useMobileExtensionRegistry,
} from './app-providers';
import { SettingsScreen } from './settings-screen';
import type { MobileExtension } from '../../../extensions/types';
import {
  AppConfigProvider,
  createDefaultAppConfig,
  type AppConfigCache,
  type AppConfigReader,
} from '../../app-config';
import { publishApiAppGate } from '../../../shared/api-client';

function BootGateProbe() {
  const state = useBootShellState();
  return (
    <Text testID="boot-gate-state">
      {`${state.updateRequired ? 'update' : 'ok'}:${String(state.maintenance)}`}
    </Text>
  );
}

beforeEach(() => {
  jest
    .spyOn(AppState, 'addEventListener')
    .mockReturnValue({ remove: jest.fn() } as ReturnType<typeof AppState.addEventListener>);
});

describe('mobile shell providers', () => {
  it('renders with an empty extension list and an extension settings item with its namespace', async () => {
    const empty = await render(
      <AppProviders extensions={[]} initialLocale="pt-BR">
        <SettingsScreen />
      </AppProviders>,
    );
    expect(screen.getByText('Configurações')).toBeTruthy();
    expect(screen.queryByText('Fake settings')).toBeNull();
    await empty.unmount();

    const FakeSettingsItem = () => {
      const { t } = useTranslation('fake');
      return <Text>{t('label')}</Text>;
    };
    const extension: MobileExtension = {
      name: 'sample-extension',
      bootGates: [{ name: 'sample-gate', evaluate: () => ({ status: 'pass' }) }],
      settingsItems: [{ id: 'sample', section: 'extensions', Component: FakeSettingsItem }],
      i18nNamespaces: [
        {
          name: 'fake',
          resources: {
            'pt-BR': { label: 'Fake settings' },
            en: { label: 'Fake settings' },
            es: { label: 'Fake settings' },
          },
        },
      ],
    };
    const GateRegistryProbe = () => {
      const registry = useMobileExtensionRegistry();
      return <Text>{registry.bootGates[0]?.name}</Text>;
    };

    await render(
      <AppProviders
        extensions={[extension]}
        initialLocale="pt-BR"
        sessionSummary={{ userId: '5fa6acc4-75aa-4e60-8129-3db379c1c804', isAnonymous: false }}
      >
        <SettingsScreen />
        <GateRegistryProbe />
      </AppProviders>,
    );
    expect(screen.getByText('Fake settings')).toBeTruthy();
    expect(screen.getByText('sample-gate')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Inglês' }));
    expect(screen.getByText('Settings')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Dark' }));
    expect(screen.getByText('Settings')).toBeTruthy();
  });

  it('routes a public API update signal through the mounted boot guards', async () => {
    const config = createDefaultAppConfig();
    const cache: AppConfigCache = {
      read: async () => config,
      write: async () => undefined,
      clear: async () => undefined,
    };
    const reader: AppConfigReader = jest.fn<
      ReturnType<AppConfigReader>,
      Parameters<AppConfigReader>
    >();
    const view = await render(
      <AppProviders extensions={[]} initialLocale="en">
        <AppConfigProvider
          cache={cache}
          reader={reader}
          appVersion="1.0.0"
          platform="ios"
          onlineOverride={false}
          foregroundOverride
        >
          <AppConfigBootBridge>
            <BootGateProbe />
          </AppConfigBootBridge>
        </AppConfigProvider>
      </AppProviders>,
    );
    expect(await view.findByText('ok:false')).toBeTruthy();
    await act(async () => publishApiAppGate('update'));
    expect(await view.findByText('update:false')).toBeTruthy();

    await act(async () => publishApiAppGate('maintenance'));
    expect(await view.findByText('ok:false')).toBeTruthy();
    await view.unmount();
  });

  it('keeps a cached required update ahead of a later maintenance response', async () => {
    const defaultConfig = createDefaultAppConfig();
    const config = {
      ...defaultConfig,
      versions: {
        ...defaultConfig.versions,
        ios: {
          ...defaultConfig.versions.ios,
          minSupported: '2.0.0',
          latest: '2.0.0',
        },
      },
    };
    const cache: AppConfigCache = {
      read: async () => config,
      write: async () => undefined,
      clear: async () => undefined,
    };
    let resolveRemote!: (value: typeof config) => void;
    const remote = new Promise<typeof config>((resolve) => {
      resolveRemote = resolve;
    });
    const reader: AppConfigReader = jest.fn().mockReturnValue(remote);
    const tree = (onlineOverride: boolean) => (
      <AppProviders extensions={[]} initialLocale="en">
        <AppConfigProvider
          cache={cache}
          reader={reader}
          appVersion="1.0.0"
          platform="ios"
          onlineOverride={onlineOverride}
          foregroundOverride
        >
          <AppConfigBootBridge>
            <BootGateProbe />
          </AppConfigBootBridge>
        </AppConfigProvider>
      </AppProviders>
    );
    const view = await render(tree(false));
    expect(await view.findByText('update:false')).toBeTruthy();
    await view.rerender(tree(true));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reader).toHaveBeenCalledTimes(1);
    await act(async () => publishApiAppGate('maintenance'));
    expect(view.getByText('update:false')).toBeTruthy();
    await view.unmount();
    resolveRemote(config);
    await remote;
  });
});
