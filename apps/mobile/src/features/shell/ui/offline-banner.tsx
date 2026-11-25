import { useNetInfo } from '@react-native-community/netinfo';
import React from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../../shared/theme/theme';

export function OfflineBanner() {
  const network = useNetInfo();
  const isConnected = network?.isConnected;
  const { t } = useTranslation('common');
  const { theme } = useTheme();

  if (isConnected !== false) {
    return null;
  }

  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={t('offlineHint')}
      style={{ backgroundColor: theme.colors.surface, padding: theme.spacing.md }}
    >
      <Text style={{ color: theme.colors.text, fontSize: theme.typography.body }}>
        {t('offline')}: {t('offlineHint')}
      </Text>
    </View>
  );
}
