import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkApiRouteHandlers } from './routes-use-define-route.mjs';

function createFixture(): string {
  return mkdtempSync(join(tmpdir(), 'base-app-route-contract-'));
}

function writeFixture(root: string, relativePath: string, content: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function writePlatformHttpStub(root: string): void {
  writeFixture(
    root,
    'apps/web/src/platform/http/index.ts',
    'export const defineRoute = (options: unknown): unknown => options;\n',
  );
}

describe('routes-use-define-route AST check', () => {
  it('follows a thin API route through a public context index to defineRoute', () => {
    const root = createFixture();
    try {
      writePlatformHttpStub(root);
      writeFixture(
        root,
        'apps/web/src/app/api/v1/me/route.ts',
        "export { GET } from '@/modules/identity';\n",
      );
      writeFixture(
        root,
        'apps/web/src/modules/identity/index.ts',
        "export { GET } from './features/get-profile/presentation/route';\n",
      );
      writeFixture(
        root,
        'apps/web/src/modules/identity/features/get-profile/presentation/route.ts',
        "import { defineRoute } from '@/platform/http';\nexport const GET = defineRoute({ auth: { kind: 'user' } });\n",
      );

      expect(checkApiRouteHandlers(root)).toEqual({ checked: 1, failures: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts an aliased defineRoute import from the actual platform/http module', () => {
    const root = createFixture();
    try {
      writePlatformHttpStub(root);
      writeFixture(
        root,
        'apps/web/src/app/api/v1/health/route.ts',
        "import { defineRoute as route } from '@/platform/http';\nexport const GET = route({ auth: { kind: 'public' } });\n",
      );

      expect(checkApiRouteHandlers(root)).toEqual({ checked: 1, failures: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects bare and lookalike platform/http imports', () => {
    const root = createFixture();
    try {
      writePlatformHttpStub(root);
      writeFixture(
        root,
        'apps/web/src/modules/identity/platform/http/index.ts',
        'export const defineRoute = (options: unknown): unknown => options;\n',
      );
      const routePath = 'apps/web/src/app/api/v1/health/route.ts';
      writeFixture(
        root,
        routePath,
        "import { defineRoute } from '@/modules/identity/platform/http';\nexport const GET = defineRoute({ auth: { kind: 'public' } });\n",
      );

      expect(checkApiRouteHandlers(root).failures).toEqual([
        'apps/web/src/app/api/v1/health/route.ts: GET is not created by an imported platform/http defineRoute.',
      ]);

      writeFixture(
        root,
        routePath,
        "import { defineRoute } from 'platform/http';\nexport const GET = defineRoute({ auth: { kind: 'public' } });\n",
      );
      expect(checkApiRouteHandlers(root).failures).toEqual([
        'apps/web/src/app/api/v1/health/route.ts: GET is not created by an imported platform/http defineRoute.',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a local defineRoute lookalike and a directly implemented handler', () => {
    const root = createFixture();
    try {
      writeFixture(
        root,
        'apps/web/src/app/api/v1/health/route.ts',
        `const defineRoute = (handler: () => Response) => handler;
export const GET = defineRoute(() => Response.json({ status: 'ok' }));
export function POST(): Response { return Response.json({ status: 'ok' }); }
`,
      );

      const result = checkApiRouteHandlers(root);

      expect(result.checked).toBe(1);
      expect(result.failures).toEqual([
        'apps/web/src/app/api/v1/health/route.ts: GET is not created by an imported platform/http defineRoute.',
        'apps/web/src/app/api/v1/health/route.ts: POST is not created by an imported platform/http defineRoute.',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
