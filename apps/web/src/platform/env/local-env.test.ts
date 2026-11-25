import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRootLocalEnvironment } from '../../../scripts/local-env.mjs';

const originalValues = new Map<string, string | undefined>();
let temporaryRoot: string | undefined;

function rememberEnvironment(...names: string[]) {
  for (const name of names) {
    if (!originalValues.has(name)) originalValues.set(name, process.env[name]);
  }
}

afterEach(() => {
  for (const [name, value] of originalValues) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalValues.clear();
  if (temporaryRoot) rmSync(temporaryRoot, { force: true, recursive: true });
  temporaryRoot = undefined;
});

describe('loadRootLocalEnvironment', () => {
  it('loads the root fixture before local host selection without replacing injected values', () => {
    rememberEnvironment('APP_HOST', 'W1_LOCAL_ENV_FIXTURE');
    process.env.APP_HOST = 'injected.example.test';
    delete process.env.W1_LOCAL_ENV_FIXTURE;
    temporaryRoot = mkdtempSync(join(tmpdir(), 'base-app-env-'));
    writeFileSync(
      join(temporaryRoot, '.env.local'),
      'APP_HOST=file.example.test\nW1_LOCAL_ENV_FIXTURE=loaded\n',
    );

    expect(loadRootLocalEnvironment(temporaryRoot, { command: 'dev', environment: {} })).toBe(true);
    expect(process.env.APP_HOST).toBe('injected.example.test');
    expect(process.env.W1_LOCAL_ENV_FIXTURE).toBe('loaded');
  });

  it('returns safely when the root local env file is absent', () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'base-app-env-'));

    expect(loadRootLocalEnvironment(temporaryRoot, { command: 'start', environment: {} })).toBe(
      false,
    );
  });

  it.each([
    ['CI', { CI: 'true' }],
    ['Vercel preview', { VERCEL_ENV: 'preview' }],
    ['Vercel production', { VERCEL_ENV: 'production' }],
    ['build', {}],
  ])('does not read local env files for %s', (_label, additions) => {
    rememberEnvironment('CI', 'VERCEL_ENV', 'W1_LOCAL_ENV_FIXTURE');
    delete process.env.W1_LOCAL_ENV_FIXTURE;
    temporaryRoot = mkdtempSync(join(tmpdir(), 'base-app-env-'));
    writeFileSync(join(temporaryRoot, '.env.local'), 'W1_LOCAL_ENV_FIXTURE=must-not-load\n');
    const environment = { ...process.env, ...additions };
    if (!('CI' in additions)) delete environment.CI;
    if (!('VERCEL_ENV' in additions)) delete environment.VERCEL_ENV;
    const command = _label === 'build' ? 'build' : 'dev';

    expect(loadRootLocalEnvironment(temporaryRoot, { command, environment })).toBe(false);
    expect(process.env.W1_LOCAL_ENV_FIXTURE).toBeUndefined();
  });
});
