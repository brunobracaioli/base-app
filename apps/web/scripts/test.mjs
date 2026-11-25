import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDirectory, '..');
const workspaceRoot = resolve(appRoot, '../..');
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const forwardedTestArgs = process.argv.slice(2);
if (forwardedTestArgs[0] === '--') forwardedTestArgs.shift();

let dependencyBuildFailed = false;
for (const packageName of ['@base-app/config', '@base-app/contracts']) {
  const dependencyBuild = spawnSync(packageManager, ['--filter', packageName, 'build'], {
    cwd: workspaceRoot,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (dependencyBuild.status !== 0) {
    process.exitCode = dependencyBuild.status ?? 1;
    dependencyBuildFailed = true;
    break;
  }
}
if (!dependencyBuildFailed) {
  const siteEnvironmentCheck = spawnSync(packageManager, ['--filter', 'web', 'site-env:check'], {
    cwd: workspaceRoot,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (siteEnvironmentCheck.status !== 0) {
    process.exitCode = siteEnvironmentCheck.status ?? 1;
    dependencyBuildFailed = true;
  }
}
if (!dependencyBuildFailed) {
  const vitestArguments = ['exec', 'vitest', 'run'];
  if (forwardedTestArgs.length === 0) vitestArguments.push('--coverage');
  vitestArguments.push(...forwardedTestArgs);
  const testRun = spawnSync(packageManager, vitestArguments, {
    cwd: appRoot,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exitCode = testRun.status ?? 1;
}
