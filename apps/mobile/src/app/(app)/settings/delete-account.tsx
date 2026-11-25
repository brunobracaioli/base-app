import React from 'react';

import { InformationReservedScreen } from '../../../features/shell/ui/screens';

export default function DeleteAccountRoute() {
  return (
    <InformationReservedScreen
      namespace="privacy"
      titleKey="deleteAccount"
      messageKey="notConfigured"
    />
  );
}
