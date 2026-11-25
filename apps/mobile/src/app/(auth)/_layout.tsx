import { Stack } from 'expo-router';
import React from 'react';

import { useAppSessionSummary, useBootShellState } from '../../features/shell/ui/app-providers';

export default function AuthLayout() {
  const session = useAppSessionSummary();
  const boot = useBootShellState();
  const canUseAuth = !boot.updateRequired && !boot.maintenance && session === null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={canUseAuth}>
        <Stack.Screen name="welcome" />
        <Stack.Screen name="email" />
        <Stack.Screen name="code" />
        <Stack.Screen name="password" />
        <Stack.Screen name="sign-up" />
        <Stack.Screen name="forgot-password" />
        <Stack.Screen name="new-password" />
      </Stack.Protected>
    </Stack>
  );
}
