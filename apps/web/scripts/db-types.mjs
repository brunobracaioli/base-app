import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(appRoot, '../..');
const packageManagerBin = process.platform === 'win32' ? 'kysely-codegen.cmd' : 'kysely-codegen';
const argumentsList = [
  '--out-file',
  'src/platform/db/types.ts',
  '--date-parser',
  'string',
  '--include-pattern',
  '{audit,app_config,identity,ops,platform,privacy}.*',
  '--default-schema',
  'public',
  '--type-mapping',
  JSON.stringify({ timestamp: 'string', timestamptz: 'string' }),
];
const environmentFile = resolve(workspaceRoot, '.env.local');
if (process.env.CI === undefined && existsSync(environmentFile)) {
  argumentsList.push('--env-file', environmentFile);
}

const result = spawnSync(packageManagerBin, argumentsList, {
  cwd: appRoot,
  env: process.env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) {
  process.stderr.write('Kysely type generation could not start.\n');
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
