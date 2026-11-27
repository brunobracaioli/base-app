import { Stack } from 'expo-router';
import React from 'react';

import { useAppSessionSummary, useBootShellState } from '../../features/shell/ui/app-providers';

export default function GateLayout() {
  const session = useAppSessionSummary();
  const boot = useBootShellState();
  const baseAllowsGate = !boot.updateRequired && !boot.maintenance;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={boot.updateRequired}>
        <Stack.Screen name="update" />
      </Stack.Protected>
      <Stack.Protected guard={!boot.updateRequired && boot.maintenance}>
        <Stack.Screen name="maintenance" />
      </Stack.Protected>
      <Stack.Protected guard={baseAllowsGate && session !== null && !boot.termsAccepted}>
        <Stack.Screen name="terms" />
      </Stack.Protected>
      <Stack.Protected
        guard={baseAllowsGate && boot.extensionBlock?.href === '/(gates)/extension-error'}
      >
        <Stack.Screen name="extension-error" />
      </Stack.Protected>
    </Stack>
  );
}
