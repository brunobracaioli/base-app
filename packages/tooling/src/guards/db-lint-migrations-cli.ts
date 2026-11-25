import { MigrationLintError, runMigrationLintCli } from './db-lint-migrations.js';

void runMigrationLintCli().catch((error: unknown) => {
  const message =
    error instanceof MigrationLintError ? error.message : 'Migration policy check failed.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
