import * as Sentry from '@sentry/react-native';
import { type ErrorBoundaryProps } from 'expo-router';
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AppConfigProvider } from '../features/app-config/ui/app-config-provider';
import {
  AppConfigBootBridge,
  AppProviders,
  AuthRuntimeBootstrap,
} from '../features/shell/ui/app-providers';
import { RootNavigator } from '../features/shell/ui/root-navigator';
import { initializeSentry } from '../shared/telemetry/sentry';

const sentryEnabled = initializeSentry(process.env.EXPO_PUBLIC_SENTRY_DSN);

function RootLayout() {
  return (
    <AppProviders>
      <AppConfigProvider>
        <AppConfigBootBridge>
          <AuthRuntimeBootstrap>
            <RootNavigator />
          </AuthRuntimeBootstrap>
        </AppConfigBootBridge>
      </AppConfigProvider>
    </AppProviders>
  );
}

export function ErrorBoundary({ retry }: ErrorBoundaryProps) {
  const { t } = useTranslation('common');
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
      <Text accessibilityRole="header">{t('genericError')}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('retry')}
        onPress={retry}
        style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 16 }}
      >
        <Text>{t('retry')}</Text>
      </Pressable>
    </View>
  );
}

export default sentryEnabled ? Sentry.wrap(RootLayout) : RootLayout;
