import * as Sentry from '@sentry/nextjs';

import { redactSentryEvent } from './src/platform/observability/redaction';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    beforeSend(event) {
      return redactSentryEvent(event);
    },
  });
}
