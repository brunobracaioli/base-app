import React from 'react';

import { InformationReservedScreen } from '../../features/shell/ui/screens';

export default function PaywallRoute() {
  return (
    <InformationReservedScreen namespace="billing" titleKey="title" messageKey="notConfigured" />
  );
}
