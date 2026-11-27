import { Stack } from 'expo-router';
import React from 'react';

import { resolveRouteGroupAccess } from '../../boot/model/resolve-boot';
import { useAppSessionSummary, useBootShellState } from './app-providers';

export function RootNavigator() {
  const session = useAppSessionSummary();
  const boot = useBootShellState();
  const access = resolveRouteGroupAccess({ ...boot, session });

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={access.gates}>
        <Stack.Screen name="(gates)" />
      </Stack.Protected>
      <Stack.Protected guard={access.auth}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
      <Stack.Protected guard={access.app}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={access.ext}>
        <Stack.Screen name="(ext)" />
      </Stack.Protected>
    </Stack>
  );
}
