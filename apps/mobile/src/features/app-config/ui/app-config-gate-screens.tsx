import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { openExternalUrl } from '../../../shared/urls';
import { useTheme } from '../../../shared/theme/theme';
import { resolveNativePlatform, useAppConfig } from './app-config-provider';

type UpdateGateContentProps = {
  readonly storeUrl: string;
  readonly openStore?: (url: string) => Promise<boolean>;
};

export function UpdateGateContent({
  storeUrl,
  openStore = openExternalUrl,
}: UpdateGateContentProps) {
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
      <Text
        accessibilityRole="header"
        style={{ color: theme.colors.text, fontSize: theme.typography.heading }}
      >
        {t('updateTitle')}
      </Text>
      <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.body }}>
        {t('updateMessage')}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('updateAction')}
        onPress={() => {
          void openStore(storeUrl);
        }}
        style={{ minHeight: 48, justifyContent: 'center', alignItems: 'center' }}
      >
        <Text style={{ color: theme.colors.text, fontSize: theme.typography.body }}>
          {t('updateAction')}
        </Text>
      </Pressable>
    </View>
  );
}

type MaintenanceGateContentProps = {
  readonly messageKey: string;
  readonly until: string | null;
  readonly onRetry?: () => void;
};

export function MaintenanceGateContent({
  messageKey,
  until,
  onRetry,
}: MaintenanceGateContentProps) {
  const { t, i18n } = useTranslation('gates');
  const { theme } = useTheme();
  const safeMessageKey = i18n.exists(messageKey, { ns: 'gates' })
    ? messageKey
    : 'maintenance.default';
  const translateGateMessage = i18n.getFixedT(i18n.language, 'gates') as (key: string) => string;

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
        {t('maintenanceTitle')}
      </Text>
      <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.body }}>
        {translateGateMessage(safeMessageKey)}
      </Text>
      {until !== null && (
        <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.body }}>
          {t('maintenanceUntil', { until })}
        </Text>
      )}
      {onRetry !== undefined && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('retryAction')}
          onPress={onRetry}
          style={{ minHeight: 48, justifyContent: 'center', alignItems: 'center' }}
        >
          <Text style={{ color: theme.colors.text, fontSize: theme.typography.body }}>
            {t('retryAction')}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

export function UpdateGateScreen() {
  const { config } = useAppConfig();
  const platform = resolveNativePlatform();
  return <UpdateGateContent storeUrl={config.versions[platform].storeUrl} />;
}

export function MaintenanceGateScreen() {
  const { config, refresh } = useAppConfig();
  return (
    <MaintenanceGateContent
      messageKey={config.maintenance.messageKey}
      until={config.maintenance.until}
      onRetry={() => {
        void refresh();
      }}
    />
  );
}
