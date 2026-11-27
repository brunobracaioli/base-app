import { Stack } from 'expo-router';
import React from 'react';

import { useAppSessionSummary, useBootShellState } from '../../features/shell/ui/app-providers';

export default function AppLayout() {
  const session = useAppSessionSummary();
  const boot = useBootShellState();
  const canUseProduct =
    !boot.updateRequired &&
    !boot.maintenance &&
    session !== null &&
    boot.termsAccepted &&
    boot.extensionBlock === null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={canUseProduct}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="paywall" />
        <Stack.Screen name="reauth" />
      </Stack.Protected>
    </Stack>
  );
}
