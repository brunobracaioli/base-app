import { useRouter, type Href } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { Locale } from '../../../extensions/types';
import { useOptionalAuthRuntime } from '../../../composition/auth-runtime';
import { translateMobile } from '../../../shared/i18n';
import { useTheme, type ThemeMode } from '../../../shared/theme/theme';
import { useAppSessionSummary, useMobileExtensionRegistry } from './app-providers';

const localeOptions: readonly { readonly locale: Locale; readonly labelKey: string }[] = [
  { locale: 'pt-BR', labelKey: 'languagePtBr' },
  { locale: 'en', labelKey: 'languageEn' },
  { locale: 'es', labelKey: 'languageEs' },
];

const themeOptions: readonly { readonly mode: ThemeMode; readonly labelKey: string }[] = [
  { mode: 'system', labelKey: 'themeSystem' },
  { mode: 'light', labelKey: 'themeLight' },
  { mode: 'dark', labelKey: 'themeDark' },
];

function ChoiceButton({
  label,
  selected,
  onPress,
  testID,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly testID?: string;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      testID={testID}
      onPress={onPress}
      style={{
        minHeight: 48,
        justifyContent: 'center',
        paddingHorizontal: theme.spacing.md,
        backgroundColor: selected ? theme.colors.primary : theme.colors.surface,
        borderRadius: theme.radius.md,
      }}
    >
      <Text
        style={{
          color: selected ? theme.colors.onPrimary : theme.colors.text,
          fontSize: theme.typography.body,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function SettingsScreen() {
  const { t, i18n } = useTranslation('settings');
  const { theme, mode, setMode } = useTheme();
  const session = useAppSessionSummary();
  const authRuntime = useOptionalAuthRuntime();
  const registry = useMobileExtensionRegistry();
  const router = useRouter();
  const [status, setStatus] = React.useState<string | null>(null);
  const busy = authRuntime?.snapshot.isBusy ?? false;

  const changeLocale = async (locale: Locale) => {
    if (authRuntime === null) {
      await i18n.changeLanguage(locale);
      setStatus(t('localeSaved'));
      return;
    }
    if (authRuntime.controller == null) {
      setStatus(t('profileError'));
      return;
    }
    const result = await authRuntime.controller.updateLocale(locale);
    if (!result.ok) {
      setStatus(translateMobile(`errors.${result.error}`));
      return;
    }
    await i18n.changeLanguage(locale);
    setStatus(t('localeSaved'));
  };

  const signOut = async (scope: 'local' | 'global') => {
    if (authRuntime?.controller == null) {
      setStatus(translateMobile('errors.auth.unavailable'));
      return;
    }
    const result = await authRuntime.controller.signOut(scope);
    if (!result.ok) {
      setStatus(translateMobile(`errors.${result.error}`));
      return;
    }
    router.replace('/(auth)/welcome');
  };

  const settingAction = (label: string, onPress: () => void, testID?: string, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: 48,
        justifyContent: 'center',
        paddingHorizontal: theme.spacing.md,
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.md,
      }}
    >
      <Text style={{ color: theme.colors.text, fontSize: theme.typography.body }}>{label}</Text>
    </Pressable>
  );

  return (
    <ScrollView
      accessibilityLabel={t('title')}
      contentContainerStyle={{
        padding: theme.spacing.lg,
        gap: theme.spacing.lg,
        backgroundColor: theme.colors.background,
      }}
    >
      <Text
        accessibilityRole="header"
        style={{ color: theme.colors.text, fontSize: theme.typography.heading }}
      >
        {t('title')}
      </Text>

      <View style={{ gap: theme.spacing.sm }}>
        <Text
          accessibilityRole="header"
          style={{ color: theme.colors.text, fontSize: theme.typography.title }}
        >
          {t('preferences')}
        </Text>
        <Text style={{ color: theme.colors.text, fontSize: theme.typography.body }}>
          {t('language')}
        </Text>
        {localeOptions.map(({ locale, labelKey }) => {
          const label = t(labelKey);
          return (
            <ChoiceButton
              key={locale}
              label={label}
              testID={`settings.locale.${locale}`}
              selected={
                (authRuntime?.snapshot.me?.locale ?? i18n.language).toLowerCase() ===
                locale.toLowerCase()
              }
              onPress={() => void changeLocale(locale)}
            />
          );
        })}
        <Text style={{ color: theme.colors.text, fontSize: theme.typography.body }}>
          {t('theme')}
        </Text>
        {themeOptions.map(({ mode: nextMode, labelKey }) => (
          <ChoiceButton
            key={nextMode}
            label={t(labelKey)}
            testID={`settings.theme.${nextMode}`}
            selected={mode === nextMode}
            onPress={() => {
              void setMode(nextMode);
            }}
          />
        ))}
      </View>

      <View style={{ gap: theme.spacing.sm }}>
        <Text
          accessibilityRole="header"
          style={{ color: theme.colors.text, fontSize: theme.typography.title }}
        >
          {t('account')}
        </Text>
        {authRuntime?.snapshot.me?.email !== null &&
          authRuntime?.snapshot.me?.email !== undefined && (
            <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.body }}>
              {authRuntime.snapshot.me.email}
            </Text>
          )}
        {authRuntime?.snapshot.me?.displayName !== null &&
          authRuntime?.snapshot.me?.displayName !== undefined && (
            <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.body }}>
              {authRuntime.snapshot.me.displayName}
            </Text>
          )}
        {settingAction(
          t('manageAccount'),
          () => router.push('/(app)/settings/account'),
          'settings.manage-account',
        )}
      </View>
      <View style={{ gap: theme.spacing.sm }}>
        <Text
          accessibilityRole="header"
          style={{ color: theme.colors.text, fontSize: theme.typography.title }}
        >
          {t('subscription')}
        </Text>
        <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.body }}>
          {t('notConfigured')}
        </Text>
      </View>
      <View style={{ gap: theme.spacing.sm }}>
        <Text
          accessibilityRole="header"
          style={{ color: theme.colors.text, fontSize: theme.typography.title }}
        >
          {t('legal')}
        </Text>
        <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.body }}>
          {t('notConfigured')}
        </Text>
      </View>
      <View style={{ gap: theme.spacing.sm }}>
        <Text
          accessibilityRole="header"
          style={{ color: theme.colors.text, fontSize: theme.typography.title }}
        >
          {t('privacy')}
        </Text>
        <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.body }}>
          {t('notConfigured')}
        </Text>
      </View>
      {registry.settingsItems.length > 0 && (
        <View style={{ gap: theme.spacing.sm }}>
          <Text
            accessibilityRole="header"
            style={{ color: theme.colors.text, fontSize: theme.typography.title }}
          >
            {t('extensions')}
          </Text>
          {session !== null &&
            registry.settingsItems.map(({ id, Component }) => (
              <Component
                key={id}
                session={session}
                navigate={(route) => router.push(route as Href)}
              />
            ))}
        </View>
      )}
      {status !== null && (
        <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.mutedText }}>
          {status}
        </Text>
      )}
      <View style={{ gap: theme.spacing.sm }}>
        {settingAction(t('signOut'), () => void signOut('local'), 'settings.sign-out', busy)}
        {settingAction(
          t('signOutEverywhere'),
          () => void signOut('global'),
          'settings.sign-out-all',
          busy,
        )}
      </View>
    </ScrollView>
  );
}
