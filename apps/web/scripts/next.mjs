import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRootLocalEnvironment } from './local-env.mjs';

const command = process.argv[2];
if (!['dev', 'build', 'start'].includes(command ?? '')) {
  process.stderr.write('Usage: node scripts/next.mjs <dev|build|start>\n');
  process.exitCode = 2;
} else {
  const require = createRequire(import.meta.url);
  const nextPackageDirectory = dirname(require.resolve('next/package.json'));
  const nextCli = resolve(nextPackageDirectory, 'dist/bin/next');
  const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  loadRootLocalEnvironment(workspaceRoot, { command, environment: process.env });
  const port = process.env.PORT ?? '3000';
  const isRemoteEnvironment =
    process.env.VERCEL_ENV === 'preview' || process.env.VERCEL_ENV === 'production';
  const configuredHost = process.env.APP_HOST?.trim();

  if (isRemoteEnvironment && !configuredHost) {
    process.stderr.write('APP_HOST is required in Vercel preview and production.\n');
    process.exitCode = 1;
  } else {
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
      const siteEnvironmentCheck = spawnSync(
        packageManager,
        ['--filter', 'web', 'site-env:check'],
        {
          cwd: workspaceRoot,
          env: process.env,
          stdio: 'inherit',
          shell: process.platform === 'win32',
        },
      );
      if (siteEnvironmentCheck.status !== 0) {
        process.exitCode = siteEnvironmentCheck.status ?? 1;
        dependencyBuildFailed = true;
      }
    }
    if (!dependencyBuildFailed) {
      const environment = {
        ...process.env,
        APP_HOST: configuredHost || `localhost:${port}`,
      };
      const args = [nextCli, command];
      if (command !== 'build') args.push('--hostname', '127.0.0.1', '--port', port);
      const nextProcess = spawn(process.execPath, args, { stdio: 'inherit', env: environment });

      nextProcess.on('error', () => {
        process.stderr.write('Next.js process could not start.\n');
        process.exitCode = 1;
      });
      nextProcess.on('exit', (code, signal) => {
        process.exitCode = code ?? (signal ? 1 : 0);
      });
    }
  }
}
