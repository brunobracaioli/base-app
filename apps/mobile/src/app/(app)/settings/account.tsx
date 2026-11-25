import React from 'react';

import { InformationReservedScreen } from '../../../features/shell/ui/screens';

export default function AccountSettingsRoute() {
  return (
    <InformationReservedScreen namespace="settings" titleKey="account" messageKey="notConfigured" />
  );
}
