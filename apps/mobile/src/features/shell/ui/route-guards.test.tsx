import { Stack } from 'expo-router';
import { renderRouter, screen } from 'expo-router/testing-library';
import React from 'react';
import { Text } from 'react-native';

import AppLayout from '../../../app/(app)/_layout';
import SettingsLayout from '../../../app/(app)/settings/_layout';
import AuthLayout from '../../../app/(auth)/_layout';
import ExtensionLayout from '../../../app/(ext)/_layout';
import GateLayout from '../../../app/(gates)/_layout';
import { RootNavigator } from './root-navigator';

type BootShellState = {
  updateRequired: boolean;
  maintenance: boolean;
  termsAccepted: boolean;
  offline: boolean;
  extensionBlock: { href: string } | null;
};

// jest.setup.ts stubs expo-router and the safe-area provider; this suite needs the real ones.
jest.unmock('expo-router');
jest.unmock('react-native-safe-area-context');

let mockSession: { userId: string } | null = null;
let mockBoot: BootShellState;

jest.mock('./app-providers', () => ({
  useAppSessionSummary: () => mockSession,
  useBootShellState: () => mockBoot,
}));

function stub(label: string) {
  return function StubScreen() {
    return <Text>{label}</Text>;
  };
}

function TabsStack() {
  return <Stack screenOptions={{ headerShown: false }} />;
}

const routes = {
  _layout: RootNavigator,
  '(gates)/_layout': GateLayout,
  '(gates)/terms': stub('gate:terms'),
  '(auth)/_layout': AuthLayout,
  '(auth)/welcome': stub('auth:welcome'),
  '(app)/_layout': AppLayout,
  '(app)/(tabs)/_layout': TabsStack,
  '(app)/(tabs)/index': stub('app:home'),
  '(app)/settings/_layout': SettingsLayout,
  '(app)/settings/account': stub('settings:account'),
  '(app)/settings/legal': stub('settings:legal'),
  '(ext)/_layout': ExtensionLayout,
  '(ext)/sample': stub('ext:sample'),
};

describe('route guards', () => {
  beforeEach(() => {
    mockSession = null;
    mockBoot = {
      updateRequired: false,
      maintenance: false,
      termsAccepted: false,
      offline: false,
      extensionBlock: null,
    };
  });

  it('opens the welcome screen when there is no session', async () => {
    // act
    await renderRouter(routes, { initialUrl: '/' });

    // assert
    expect(await screen.findByText('auth:welcome')).toBeTruthy();
    expect(screen.queryByText('settings:legal')).toBeNull();
    expect(screen.queryByText('settings:account')).toBeNull();
  });

  it('keeps settings screens behind the session guard', async () => {
    // act
    await renderRouter(routes, { initialUrl: '/settings/legal' });

    // assert
    expect(await screen.findByText('auth:welcome')).toBeTruthy();
    expect(screen.queryByText('settings:legal')).toBeNull();
  });

  it('sends a signed-in user who has not accepted the terms to the terms gate', async () => {
    // arrange
    mockSession = { userId: '00000000-0000-4000-8000-000000000001' };

    // act
    await renderRouter(routes, { initialUrl: '/settings/legal' });

    // assert
    expect(await screen.findByText('gate:terms')).toBeTruthy();
    expect(screen.queryByText('settings:legal')).toBeNull();
  });

  it('keeps extension screens behind the session guard', async () => {
    // act
    await renderRouter(routes, { initialUrl: '/sample' });

    // assert
    expect(await screen.findByText('auth:welcome')).toBeTruthy();
    expect(screen.queryByText('ext:sample')).toBeNull();
  });

  it('opens settings screens for a signed-in user who accepted the terms', async () => {
    // arrange
    mockSession = { userId: '00000000-0000-4000-8000-000000000001' };
    mockBoot = { ...mockBoot, termsAccepted: true };

    // act
    await renderRouter(routes, { initialUrl: '/settings/legal' });

    // assert
    expect(await screen.findByText('settings:legal')).toBeTruthy();
  });

  it('opens the home screen for a signed-in user who accepted the terms', async () => {
    // arrange
    mockSession = { userId: '00000000-0000-4000-8000-000000000001' };
    mockBoot = { ...mockBoot, termsAccepted: true };

    // act
    await renderRouter(routes, { initialUrl: '/' });

    // assert
    expect(await screen.findByText('app:home')).toBeTruthy();
  });
});
