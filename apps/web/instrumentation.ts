import { registerOTel } from '@vercel/otel';
import { validateRuntimeEnvironment } from './src/platform/env/index';

export async function register(): Promise<void> {
  validateRuntimeEnvironment();
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./sentry.server.config');
  if (process.env.NEXT_RUNTIME === 'edge') await import('./sentry.edge.config');
  registerOTel({ serviceName: 'base-app-web' });
}

export { captureRequestError as onRequestError } from '@sentry/nextjs';
