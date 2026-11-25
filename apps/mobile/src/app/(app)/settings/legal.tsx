import React from 'react';

import { InformationReservedScreen } from '../../../features/shell/ui/screens';

export default function LegalSettingsRoute() {
  return (
    <InformationReservedScreen
      namespace="legal"
      titleKey="termsTitle"
      messageKey="termsNotConfigured"
    />
  );
}
