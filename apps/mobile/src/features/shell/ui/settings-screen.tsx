import { useRouter, type Href } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { Locale } from '../../../extensions/types';
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
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
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
  const registry = useMobileExtensionRegistry();
  const router = useRouter();

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
              selected={i18n.language.toLowerCase() === locale.toLowerCase()}
              onPress={() => {
                void i18n.changeLanguage(locale);
              }}
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
        <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.body }}>
          {t('notConfigured')}
        </Text>
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
    </ScrollView>
  );
}
