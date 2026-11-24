import { VercelConfigError, runVercelCheckCli } from './vercel-config.js';

void runVercelCheckCli().catch((error: unknown) => {
  const message =
    error instanceof VercelConfigError ? error.message : 'Vercel config command failed.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
