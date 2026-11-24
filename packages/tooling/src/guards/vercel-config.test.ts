import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkVercelConfig, validateVercelConfigText } from './vercel-config.js';

const temporaryRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'base-app-vercel-config-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Vercel config allowlist', () => {
  it('accepts only the documented top-level keys', () => {
    expect(() =>
      validateVercelConfigText(
        JSON.stringify({
          $schema: 'https://openapi.vercel.sh/vercel.json',
          functions: {},
          schedules: [],
          crons: [],
          regions: ['iad1'],
        }),
      ),
    ).not.toThrow();
  });

  it.each(['headers', 'rewrites', 'redirects', 'routes', 'cleanUrls', 'trailingSlash'])(
    'rejects platform edge override key %s',
    (key) => {
      expect(() => validateVercelConfigText(JSON.stringify({ [key]: [] }))).toThrow(
        new RegExp(key),
      );
    },
  );

  it('rejects malformed JSON and non-object roots', () => {
    expect(() => validateVercelConfigText('{')).toThrow(/Invalid vercel.json/);
    expect(() => validateVercelConfigText('[]')).toThrow(/top-level JSON object/);
    expect(() => validateVercelConfigText('null')).toThrow(/top-level JSON object/);
  });

  it('reports an absent file without claiming an existing file passed', async () => {
    const root = await makeRoot();
    expect(await checkVercelConfig(root)).toBe('absent');
    await writeFile(path.join(root, 'vercel.json'), '{"functions":{}}', 'utf8');
    expect(await checkVercelConfig(root)).toBe('checked');
  });
});
