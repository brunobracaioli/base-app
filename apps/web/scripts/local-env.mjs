// @ts-check

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load the repository's local env file before the Next.js wrapper computes APP_HOST.
 * Injected process variables take precedence because Node's loadEnvFile does not override them.
 *
 * @param {string} workspaceRoot
 * @param {{ command: string, environment?: NodeJS.ProcessEnv }} options
 */
export function loadRootLocalEnvironment(workspaceRoot, { command, environment = process.env }) {
  if (command !== 'dev' && command !== 'start') return false;
  if (environment.CI !== undefined) return false;
  if (environment.VERCEL_ENV === 'preview' || environment.VERCEL_ENV === 'production') {
    return false;
  }

  const environmentFile = resolve(workspaceRoot, '.env.local');
  if (!existsSync(environmentFile)) return false;

  process.loadEnvFile(environmentFile);
  return true;
}
