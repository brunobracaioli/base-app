// @ts-check

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkApiRouteHandlers } from './routes-use-define-route.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');
const candidateRoots = ['packages', 'apps/web/src', 'apps/mobile/src'];
const sources = candidateRoots.filter((relativePath) =>
  existsSync(resolve(repositoryRoot, relativePath)),
);

if (sources.length === 0) {
  throw new Error('No source roots are available for dependency-cruiser.');
}

const result = spawnSync(
  'depcruise',
  ['--config', resolve(repositoryRoot, '.dependency-cruiser.cjs'), ...sources],
  { cwd: repositoryRoot, stdio: 'inherit' },
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;

const routeCheck = checkApiRouteHandlers(repositoryRoot);
if (routeCheck.checked === 0) {
  process.stdout.write(
    'No API route files exist yet; route handler validation is exercised by fixtures and will scan Wave 1 routes when added.\n',
  );
}
if (routeCheck.failures.length > 0) {
  for (const failure of routeCheck.failures) {
    process.stderr.write(`${failure}\n`);
  }
  process.exitCode = 1;
}
