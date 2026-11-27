import * as Sentry from '@sentry/react-native';

import { isExpoGo } from '../runtime/app-runtime';
import { redactTelemetryBreadcrumb, redactTelemetryEvent } from './redaction';

/**
 * Starts Sentry only when a DSN is configured and the bundle runs in an app build of its own.
 * Expo Go has no Sentry native module, so development there runs without telemetry.
 * Returns whether the SDK was initialized.
 */
export function initializeSentry(dsn: string | undefined): boolean {
  if (dsn === undefined || dsn.trim().length === 0 || isExpoGo()) {
    return false;
  }
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    beforeSend: (event) => redactTelemetryEvent(event),
    beforeBreadcrumb: (breadcrumb) =>
      redactTelemetryBreadcrumb(breadcrumb) as typeof breadcrumb | null,
  });
  return true;
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
