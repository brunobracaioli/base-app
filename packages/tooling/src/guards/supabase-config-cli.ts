import { SupabaseConfigError, runSupabaseConfigCli } from './supabase-config.js';

void runSupabaseConfigCli(process.argv.slice(2)).catch((error: unknown) => {
  const message =
    error instanceof SupabaseConfigError ? error.message : 'Supabase config command failed.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
