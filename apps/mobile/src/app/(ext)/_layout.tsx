import { Redirect, Slot } from 'expo-router';
import React from 'react';

import { useAppSessionSummary, useBootShellState } from '../../features/shell/ui/app-providers';

export default function ExtensionLayout() {
  const boot = useBootShellState();
  const session = useAppSessionSummary();
  const canUseExtensions =
    !boot.updateRequired &&
    !boot.maintenance &&
    session !== null &&
    (boot.termsAccepted || boot.offline) &&
    (boot.extensionBlock === null || boot.extensionBlock.href.startsWith('/(ext)/'));

  return canUseExtensions ? <Slot /> : <Redirect href="/+not-found" />;
}
