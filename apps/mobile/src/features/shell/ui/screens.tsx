import React from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../../shared/theme/theme';
import { ScreenCaptureGuard } from './screen-capture-guard';

export function WelcomeScreen() {
  const { t } = useTranslation('auth');
  const { theme } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        padding: theme.spacing.xl,
        gap: theme.spacing.md,
        backgroundColor: theme.colors.background,
      }}
    >
      <Text
        accessibilityRole="header"
        style={{ color: theme.colors.text, fontSize: theme.typography.heading }}
      >
        {t('welcomeTitle')}
      </Text>
      <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.body }}>
        {t('welcomeDescription')}
      </Text>
    </View>
  );
}

export function HomeScreen() {
  const { t } = useTranslation('common');
  const { theme } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        padding: theme.spacing.xl,
        backgroundColor: theme.colors.background,
      }}
    >
      <Text
        accessibilityRole="header"
        testID="app.home"
        style={{ color: theme.colors.text, fontSize: theme.typography.heading }}
      >
        {t('home')}
      </Text>
    </View>
  );
}

export function AuthReservedScreen({
  titleKey,
  protectScreen = false,
}: {
  readonly titleKey: string;
  readonly protectScreen?: boolean;
}) {
  const { t } = useTranslation('auth');
  const { theme } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        padding: theme.spacing.xl,
        gap: theme.spacing.md,
        backgroundColor: theme.colors.background,
      }}
    >
      <Text
        accessibilityRole="header"
        style={{ color: theme.colors.text, fontSize: theme.typography.heading }}
      >
        {t(titleKey)}
      </Text>
      <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.body }}>
        {t('authUnavailable')}
      </Text>
      {protectScreen && <ScreenCaptureGuard />}
    </View>
  );
}

export function GateReservedScreen({
  titleKey,
  messageKey,
  protectScreen = false,
}: {
  readonly titleKey: string;
  readonly messageKey: string;
  readonly protectScreen?: boolean;
}) {
  const { t } = useTranslation('gates');
  const { theme } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        padding: theme.spacing.xl,
        gap: theme.spacing.md,
        backgroundColor: theme.colors.background,
      }}
    >
      {protectScreen && <ScreenCaptureGuard />}
      <Text
        accessibilityRole="header"
        style={{ color: theme.colors.text, fontSize: theme.typography.heading }}
      >
        {t(titleKey)}
      </Text>
      <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.body }}>
        {t(messageKey)}
      </Text>
    </View>
  );
}

export function InformationReservedScreen({
  namespace,
  titleKey,
  messageKey,
  protectScreen = false,
}: {
  readonly namespace: 'settings' | 'billing' | 'privacy' | 'legal';
  readonly titleKey: string;
  readonly messageKey: string;
  readonly protectScreen?: boolean;
}) {
  const { t } = useTranslation(namespace);
  const { theme } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        padding: theme.spacing.xl,
        gap: theme.spacing.md,
        backgroundColor: theme.colors.background,
      }}
    >
      {protectScreen && <ScreenCaptureGuard />}
      <Text
        accessibilityRole="header"
        style={{ color: theme.colors.text, fontSize: theme.typography.heading }}
      >
        {t(titleKey)}
      </Text>
      <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.body }}>
        {t(messageKey)}
      </Text>
    </View>
  );
}
