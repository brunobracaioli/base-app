import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');
const configPath = join(repositoryRoot, '.dependency-cruiser.cjs');

function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'base-app-dependency-cruiser-'));
  writeFixture(
    root,
    'tsconfig.json',
    '{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext"}}\n',
  );
  return root;
}

function writeFixture(root: string, relativePath: string, content: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function installSupabaseStub(root: string): void {
  writeFixture(
    root,
    'node_modules/@supabase/supabase-js/package.json',
    '{"name":"@supabase/supabase-js","main":"index.js"}\n',
  );
  writeFixture(
    root,
    'node_modules/@supabase/supabase-js/index.js',
    'exports.createClient = () => ({});\n',
  );
}

function importPath(fromFile: string, toFile: string): string {
  const withoutExtension = toFile.replace(/\.(?:[cm]?[jt]sx?)$/, '');
  const value = relative(dirname(fromFile), withoutExtension).replaceAll('\\', '/');
  return value.startsWith('.') ? value : `./${value}`;
}

function cruise(root: string) {
  const sourceRoots = ['apps/web/src', 'apps/mobile/src'].filter((path) =>
    existsSync(join(root, path)),
  );
  return spawnSync(
    'depcruise',
    ['--config', configPath, '--output-type', 'err-long', ...sourceRoots],
    { cwd: root, encoding: 'utf8' },
  );
}

function diagnostics(result: ReturnType<typeof cruise>): string {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

describe('dependency-cruiser architecture rules', () => {
  it('allows same-context internals and cross-context or extension public entrypoints', () => {
    const root = createFixture();
    try {
      writeFixture(
        root,
        'apps/web/src/modules/billing/index.ts',
        "export { hasEntitlement } from './features/entitlements/has-entitlement';\n",
      );
      writeFixture(
        root,
        'apps/web/src/modules/billing/features/entitlements/has-entitlement.ts',
        'export const hasEntitlement = (): boolean => true;\n',
      );
      writeFixture(
        root,
        'apps/web/src/modules/examples/features/premium-action/handler.ts',
        "import { hasEntitlement } from '../../../billing';\nvoid hasEntitlement;\n",
      );
      writeFixture(
        root,
        'apps/web/src/extensions/health-extension.ts',
        "import { hasEntitlement } from '../modules/billing';\nvoid hasEntitlement;\n",
      );
      writeFixture(
        root,
        'apps/web/src/modules/identity/index.ts',
        'export const getProfile = (): void => {};\n',
      );
      writeFixture(
        root,
        'apps/web/src/extensions/index.ts',
        'export const extensionRoute = (): void => {};\n',
      );
      writeFixture(
        root,
        'apps/web/src/platform/http/index.ts',
        'export const defineRoute = (value: unknown) => value;\n',
      );
      writeFixture(
        root,
        'apps/web/src/platform/kernel/result.ts',
        'export type Result<T> = { value: T };\n',
      );
      writeFixture(
        root,
        'apps/web/src/modules/identity/domain/profile.ts',
        "import type { Result } from '../../../platform/kernel/result';\nexport type ProfileResult = Result<string>;\n",
      );
      const routePath = 'apps/web/src/app/api/v1/me/route.ts';
      writeFixture(
        root,
        routePath,
        `import { getProfile } from '${importPath(routePath, 'apps/web/src/modules/identity/index.ts')}';\nimport { extensionRoute } from '${importPath(routePath, 'apps/web/src/extensions/index.ts')}';\nimport { defineRoute } from '${importPath(routePath, 'apps/web/src/platform/http/index.ts')}';\nvoid [getProfile, extensionRoute, defineRoute];\n`,
      );
      writeFixture(
        root,
        'apps/mobile/src/features/auth/api/session.ts',
        "import { createClient } from '@supabase/supabase-js';\nvoid createClient;\n",
      );
      installSupabaseStub(root);

      const result = cruise(root);

      expect(result.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      rule: 'no-cross-module-internals',
      entry: 'apps/web/src/modules/identity/profile.ts',
      target: 'apps/web/src/modules/billing/infrastructure/repository.ts',
      source: (entry: string, target: string) =>
        `import { readEntitlements } from '${importPath(entry, target)}';\nvoid readEntitlements;\n`,
    },
    {
      rule: 'no-unresolved',
      entry: 'apps/mobile/src/features/profile/api/query.ts',
      target: null,
      source: () => "import { missing } from '@/features/missing-module';\nvoid missing;\n",
    },
    {
      rule: 'no-cross-module-internals',
      entry: 'apps/web/src/modules/custom-a/handler.ts',
      target: 'apps/web/src/modules/custom-b/infrastructure/repository.ts',
      source: (entry: string, target: string) =>
        `import { privateValue } from '${importPath(entry, target)}';\nvoid privateValue;\n`,
    },
    {
      rule: 'no-module-cycles',
      entry: 'apps/web/src/modules/identity/index.ts',
      target: 'apps/web/src/modules/billing/index.ts',
      source: (entry: string, target: string) =>
        `import { billingValue } from '${importPath(entry, target)}';\nexport const identityValue = billingValue;\n`,
      extraTargetContent: (entry: string, target: string) =>
        `import { identityValue } from '${importPath(target, entry)}';\nexport const billingValue = identityValue;\n`,
    },
    {
      rule: 'extensions-use-module-apis',
      entry: 'apps/web/src/extensions/custom-extension.ts',
      target: 'apps/web/src/modules/custom-panel/infrastructure/repository.ts',
      source: (entry: string, target: string) =>
        `import { readPanel } from '${importPath(entry, target)}';\nvoid readPanel;\n`,
    },
    {
      rule: 'domain-is-pure-app-source',
      entry: 'apps/web/src/modules/identity/domain/profile.ts',
      target: 'apps/mobile/src/shared/profile-value.ts',
      source: (entry: string, target: string) =>
        `import { profileValue } from '${importPath(entry, target)}';\nvoid profileValue;\n`,
    },
    {
      rule: 'domain-is-pure-workspace-package',
      entry: 'apps/web/src/modules/identity/domain/profile.ts',
      target: 'packages/config/src/index.ts',
      source: (entry: string, target: string) =>
        `import { productConfig } from '${importPath(entry, target)}';\nvoid productConfig;\n`,
    },
    {
      rule: 'domain-is-pure-app-source',
      entry: 'apps/web/src/modules/identity/domain/profile.ts',
      target: 'apps/web/src/modules/billing/domain/entitlement.ts',
      source: (entry: string, target: string) =>
        `import { entitlement } from '${importPath(entry, target)}';\nvoid entitlement;\n`,
    },
    {
      rule: 'domain-is-pure-external-dependency',
      entry: 'apps/web/src/modules/identity/domain/profile.ts',
      target: null,
      source: () => "import { randomUUID } from 'node:crypto';\nvoid randomUUID;\n",
    },
    {
      rule: 'application-no-infra',
      entry: 'apps/web/src/modules/identity/features/get-profile/application/query.ts',
      target: 'apps/web/src/modules/identity/infrastructure/profile-repository.ts',
      source: (entry: string, target: string) =>
        `import { profileRepository } from '${importPath(entry, target)}';\nvoid profileRepository;\n`,
    },
    {
      rule: 'routes-are-thin',
      entry: 'apps/web/src/app/api/v1/me/route.ts',
      target: 'apps/web/src/platform/db/query.ts',
      source: (entry: string, target: string) =>
        `import { query } from '${importPath(entry, target)}';\nvoid query;\n`,
    },
    {
      rule: 'routes-are-thin-dependencies',
      entry: 'apps/web/src/app/api/v1/me/route.ts',
      target: null,
      source: () => "import { readFile } from 'node:fs';\nvoid readFile;\n",
    },
    {
      rule: 'mobile-no-server',
      entry: 'apps/mobile/src/features/profile/api/query.ts',
      target: 'apps/web/src/modules/identity/index.ts',
      source: (entry: string, target: string) =>
        `import { getProfile } from '${importPath(entry, target)}';\nvoid getProfile;\n`,
    },
    {
      rule: 'supabase-client-only-in-auth',
      entry: 'apps/mobile/src/extensions/api.ts',
      target: null,
      source: () => "import { createClient } from '@supabase/supabase-js';\nvoid createClient;\n",
      installSupabaseStub: true,
    },
    {
      rule: 'supabase-auth-adapters-only-in-auth',
      entry: 'apps/mobile/src/extensions/profile.ts',
      target: 'apps/mobile/src/features/auth/adapters/supabase-client.ts',
      source: (entry: string, target: string) =>
        `import { client } from '${importPath(entry, target)}';\nvoid client;\n`,
      targetContent: 'export const client = {};\n',
    },
    {
      rule: 'system-db-only-from-context-infrastructure',
      entry: 'apps/web/src/modules/identity/features/get-profile/application/query.ts',
      target: 'apps/web/src/platform/db/system/identity.ts',
      source: (entry: string, target: string) =>
        `import { systemDb } from '${importPath(entry, target)}';\nvoid systemDb;\n`,
    },
    {
      rule: 'system-db-per-context',
      entry: 'apps/web/src/modules/identity/infrastructure/profile-repository.ts',
      target: 'apps/web/src/platform/db/system/billing.ts',
      source: (entry: string, target: string) =>
        `import { systemDb } from '${importPath(entry, target)}';\nvoid systemDb;\n`,
    },
  ])(
    'rejects $rule violations through the real CLI',
    ({
      rule,
      entry,
      target,
      source,
      installSupabaseStub: needsSupabaseStub,
      extraTargetContent,
      targetContent,
    }) => {
      const root = createFixture();
      try {
        if (target) {
          writeFixture(root, target, targetContent ?? 'export const value = (): void => {};\n');
        }
        if (extraTargetContent && target) {
          writeFixture(root, target, extraTargetContent(entry, target));
        }
        writeFixture(root, entry, source(entry, target ?? ''));
        if (needsSupabaseStub) {
          installSupabaseStub(root);
        }

        const result = cruise(root);

        expect(result.status).not.toBe(0);
        expect(diagnostics(result)).toContain(rule);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
