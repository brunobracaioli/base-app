import { readFile } from 'node:fs/promises';
import path from 'node:path';

export class VercelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VercelConfigError';
  }
}

const allowedTopLevelKeys = new Set(['$schema', 'functions', 'schedules', 'crons', 'regions']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateVercelConfigDocument(document: unknown): void {
  if (!isRecord(document))
    throw new VercelConfigError('vercel.json must contain a top-level JSON object.');

  const unexpected = Object.keys(document)
    .filter((key) => !allowedTopLevelKeys.has(key))
    .sort();
  if (unexpected.length > 0) {
    throw new VercelConfigError(
      `vercel.json contains disallowed top-level keys: ${unexpected.join(', ')}.`,
    );
  }

  if (Object.hasOwn(document, '$schema') && typeof document.$schema !== 'string') {
    throw new VercelConfigError('vercel.json $schema must be a string.');
  }
}

export function validateVercelConfigText(source: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown JSON parser error';
    throw new VercelConfigError(`Invalid vercel.json: ${detail}`);
  }
  validateVercelConfigDocument(parsed);
}

export async function checkVercelConfig(
  projectRoot = process.cwd(),
): Promise<'checked' | 'absent'> {
  const configPath = path.join(projectRoot, 'vercel.json');
  let source: string;
  try {
    source = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'absent';
    throw error;
  }
  validateVercelConfigText(source);
  return 'checked';
}

export async function runVercelCheckCli(projectRoot = process.cwd()): Promise<void> {
  const status = await checkVercelConfig(projectRoot);
  process.stdout.write(
    status === 'checked'
      ? 'vercel.json passes the top-level allowlist.\n'
      : 'vercel.json is absent; no platform overrides to validate.\n',
  );
}
