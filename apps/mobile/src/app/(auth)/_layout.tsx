import { Stack } from 'expo-router';
import React from 'react';

import { useAppSessionSummary, useBootShellState } from '../../features/shell/ui/app-providers';
import { resolveAuthRoutePolicy } from '../../features/auth/ui/auth-route-policy';

export default function AuthLayout() {
  const session = useAppSessionSummary();
  const boot = useBootShellState();
  const canUseAuth = !boot.updateRequired && !boot.maintenance && session === null;
  const routes = resolveAuthRoutePolicy();

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={canUseAuth && routes.welcome}>
        <Stack.Screen name="welcome" />
      </Stack.Protected>
      <Stack.Protected guard={canUseAuth && routes.email}>
        <Stack.Screen name="email" />
      </Stack.Protected>
      <Stack.Protected guard={canUseAuth && routes.code}>
        <Stack.Screen name="code" />
      </Stack.Protected>
      <Stack.Protected guard={canUseAuth && routes.password}>
        <Stack.Screen name="password" />
      </Stack.Protected>
      <Stack.Protected guard={canUseAuth && routes.signUp}>
        <Stack.Screen name="sign-up" />
      </Stack.Protected>
      <Stack.Protected guard={canUseAuth && routes.forgotPassword}>
        <Stack.Screen name="forgot-password" />
      </Stack.Protected>
      <Stack.Protected guard={canUseAuth && routes.newPassword}>
        <Stack.Screen name="new-password" />
      </Stack.Protected>
    </Stack>
  );
}
