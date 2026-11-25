import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { lintAuditWrites } from './audit-writes.js';

async function main(): Promise<void> {
  const directory = resolve(process.cwd(), 'supabase/migrations');
  let files: string[];
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  } catch (error) {
    if (objectCode(error) === 'ENOENT') files = [];
    else throw error;
  }
  let failures = 0;
  for (const file of files) {
    const issues = await lintAuditWrites(await readFile(resolve(directory, file), 'utf8'));
    for (const issue of issues) process.stderr.write(`${file}: ${issue}\n`);
    failures += issues.length;
  }
  process.stdout.write(`Checked audit write boundaries in ${files.length} migration(s).\n`);
  if (failures > 0) process.exitCode = 1;
}

function objectCode(error: unknown): unknown {
  return error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

void main().catch(() => {
  process.stderr.write('Audit write policy check failed.\n');
  process.exitCode = 1;
});
