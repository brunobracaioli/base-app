import React from 'react';

import { InformationReservedScreen } from '../../../features/shell/ui/screens';

export default function ExportDataRoute() {
  return (
    <InformationReservedScreen
      namespace="privacy"
      titleKey="exportData"
      messageKey="notConfigured"
      protectScreen
    />
  );
}
