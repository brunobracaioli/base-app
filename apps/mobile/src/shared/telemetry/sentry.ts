import * as Sentry from '@sentry/react-native';

import { redactTelemetryBreadcrumb, redactTelemetryEvent } from './redaction';

export function initializeSentry(dsn: string | undefined): void {
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    beforeSend: (event) => redactTelemetryEvent(event),
    beforeBreadcrumb: (breadcrumb) =>
      redactTelemetryBreadcrumb(breadcrumb) as typeof breadcrumb | null,
  });
}

export function addAppBreadcrumb(
  category: string,
  message: string,
  data?: Readonly<Record<string, unknown>>,
): void {
  if (__DEV__) {
    return;
  }
  Sentry.addBreadcrumb({
    category: redactTelemetryEvent(category) as string,
    message: redactTelemetryEvent(message) as string,
    ...(data === undefined ? {} : { data: redactTelemetryEvent(data) as Record<string, unknown> }),
  });
}
