import { fireEvent, render, screen } from '@testing-library/react-native';
import { useTranslation } from 'react-i18next';
import { Text } from 'react-native';
import { AppProviders, useMobileExtensionRegistry } from './app-providers';
import { SettingsScreen } from './settings-screen';
import type { MobileExtension } from '../../../extensions/types';

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
});
