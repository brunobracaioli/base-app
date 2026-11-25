import { useTranslation } from 'react-i18next';
import React from 'react';
import { Text, View } from 'react-native';

export default function NotFoundScreen() {
  const { t } = useTranslation('common');
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Text accessibilityRole="header">{t('genericError')}</Text>
    </View>
  );
}
