import { Tabs } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';

export default function TabsLayout() {
  const { t } = useTranslation();
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen
        name="index"
        options={{
          title: t('home', { ns: 'common' }),
          tabBarAccessibilityLabel: t('home', { ns: 'common' }),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('title', { ns: 'settings' }),
          tabBarAccessibilityLabel: t('title', { ns: 'settings' }),
          tabBarButtonTestID: 'app.tab.settings',
        }}
      />
    </Tabs>
  );
}
