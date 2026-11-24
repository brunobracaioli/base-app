import { Linter } from 'eslint';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import baseApp from './index.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');

function lint(ruleName: string, code: string, filename = 'apps/web/src/example.ts'): string[] {
  const linter = new Linter({ cwd: repositoryRoot });
  const messages = linter.verify(
    code,
    [
      {
        files: ['**/*.js', '**/*.mjs', '**/*.cjs', '**/*.ts', '**/*.tsx'],
        languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        plugins: { 'base-app': baseApp },
        rules: { [`base-app/${ruleName}`]: 'error' },
      },
    ],
    { filename },
  );
  return messages.map((message) => message.messageId ?? message.message);
}

describe('strict-contract-objects', () => {
  const rule = 'strict-contract-objects';
  const filename = 'packages/contracts/src/profile/profile.ts';

  it('requires strictness through renamed and namespace Zod imports', () => {
    expect(
      lint(
        rule,
        "import { z as schema } from 'zod'; export const Body = schema.object({ name: schema.string() });",
        filename,
      ),
    ).toContain('strict');
    expect(
      lint(
        rule,
        "import * as toolkit from 'zod'; export const Body = toolkit.z.object({ name: toolkit.z.string() });",
        filename,
      ),
    ).toContain('strict');
  });

  it('accepts strict() and strictObject() and rejects strip outside webhooks', () => {
    expect(
      lint(
        rule,
        "import { z } from 'zod'; export const A = z.object({ a: z.string() }).strict(); export const B = z.strictObject({ b: z.string() });",
        filename,
      ),
    ).toEqual([]);
    expect(
      lint(rule, "import { z } from 'zod'; export const Body = z.object({}).strip();", filename),
    ).toContain('stripOutsideWebhook');
  });

  it('requires top-level webhook payloads to strip unknown provider fields', () => {
    const webhookPath = 'packages/contracts/src/billing/webhooks/provider-event.ts';
    expect(
      lint(
        rule,
        "import { z } from 'zod'; export const ProviderEvent = z.object({ id: z.string() }).strip();",
        webhookPath,
      ),
    ).toEqual([]);
    expect(
      lint(
        rule,
        "import { z } from 'zod'; export const ProviderEvent = z.object({ id: z.string() });",
        webhookPath,
      ),
    ).toContain('webhookPayload');
  });
});

describe('no-purge-account-outside-privacy', () => {
  const rule = 'no-purge-account-outside-privacy';

  it('blocks aliased imports, namespace access, and re-exports outside privacy', () => {
    const filename = 'apps/web/src/modules/billing/features/manage/application/use-case.ts';
    expect(
      lint(
        rule,
        "import { purgeAccount as deleteUser } from '../../privacy'; void deleteUser;",
        filename,
      ),
    ).toContain('forbidden');
    expect(
      lint(rule, "import * as privacy from '../../privacy'; privacy.purgeAccount();", filename),
    ).toContain('forbidden');
    expect(
      lint(rule, "export { purgeAccount as purge } from '../../privacy';", filename),
    ).toContain('forbidden');
  });

  it('allows imports within privacy and extensions', () => {
    expect(
      lint(
        rule,
        "import { purgeAccount } from '../../privacy'; void purgeAccount;",
        'apps/web/src/modules/privacy/features/purge/application/use-case.ts',
      ),
    ).toEqual([]);
    expect(
      lint(
        rule,
        "import { purgeAccount } from '../modules/privacy'; void purgeAccount;",
        'apps/web/src/extensions/account-lifecycle/worker.ts',
      ),
    ).toEqual([]);
  });

  it('does not trust lookalike nested extensions paths', () => {
    expect(
      lint(
        rule,
        "import { purgeAccount } from '../../../privacy'; void purgeAccount;",
        'apps/web/src/modules/identity/features/login/extensions/purge.ts',
      ),
    ).toContain('forbidden');
  });
});

describe('no-direct-jwt-verify', () => {
  const rule = 'no-direct-jwt-verify';

  it('blocks named aliases, namespace calls, and token-verifier namespace access', () => {
    expect(
      lint(
        rule,
        "import { jwtVerify as verify } from 'jose'; verify(token, key);",
        'apps/web/src/modules/identity/features/profile/application/handler.ts',
      ),
    ).toContain('directJwt');
    expect(
      lint(
        rule,
        "import * as jose from 'jose'; jose.jwtVerify(token, key);",
        'apps/web/src/modules/identity/features/profile/application/handler.ts',
      ),
    ).toContain('directJwt');
    expect(
      lint(
        rule,
        "import * as auth from '../../../platform/auth'; auth.verifyAccessToken(token);",
        'apps/web/src/modules/billing/features/check/application/handler.ts',
      ),
    ).toContain('accessToken');
  });

  it('blocks dynamic and CommonJS namespace loading outside platform/auth', () => {
    const filename = 'apps/web/src/modules/identity/features/profile/application/handler.ts';
    expect(lint(rule, "const jose = await import('jose'); void jose;", filename)).toContain(
      'directJwt',
    );
    expect(
      lint(
        rule,
        "import { jwtVerify } from 'jose/jwt/verify'; await jwtVerify(token, key);",
        filename,
      ),
    ).toContain('directJwt');
    expect(
      lint(rule, "const { jwtVerify } = require('jose'); void jwtVerify;", filename),
    ).toContain('directJwt');
    expect(lint(rule, "export * from 'jose/jwt/verify';", filename)).toContain('directJwt');
  });

  it('does not trust lookalike nested platform/auth paths', () => {
    expect(
      lint(
        rule,
        "import { jwtVerify } from 'jose'; await jwtVerify(token, key);",
        'apps/web/src/modules/identity/features/login/platform/auth/verify.ts',
      ),
    ).toContain('directJwt');
  });

  it('allows JWT verification inside platform/auth', () => {
    expect(
      lint(
        rule,
        "import { jwtVerify } from 'jose'; await jwtVerify(token, key);",
        'apps/web/src/platform/auth/verify-access-token.ts',
      ),
    ).toEqual([]);
  });
});

describe('no-dynamic-log-message', () => {
  const rule = 'no-dynamic-log-message';

  it('requires literal messages and accepts structured fields', () => {
    expect(
      lint(
        rule,
        'logger.info(`profile for ${userId}`);',
        'apps/web/src/modules/identity/service.ts',
      ),
    ).toContain('dynamic');
    expect(
      lint(
        rule,
        "context.logger.info('profile loaded', { userId });",
        'apps/web/src/modules/identity/service.ts',
      ),
    ).toEqual([]);
  });
});

describe('webhook-schemas-only-in-webhook-routes', () => {
  const rule = 'webhook-schemas-only-in-webhook-routes';
  const filename = 'apps/web/src/modules/billing/features/webhooks/presentation/route.ts';
  const validRoute = `
    import { defineRoute } from '@/platform/http';
    import { ProviderEvent } from '../../../../../../../packages/contracts/src/billing/webhooks/provider-event';
    export const POST = defineRoute({ auth: { kind: 'webhook' }, input: { body: ProviderEvent } });
  `;

  it('allows provider payloads only as webhook route bodies in module presentation', () => {
    expect(lint(rule, validRoute, filename)).toEqual([]);
  });

  it('blocks a webhook schema attached to a user route in a mixed route file', () => {
    const mixedRoutes = `${validRoute}\nexport const PATCH = defineRoute({ auth: { kind: 'user' }, input: { body: ProviderEvent } });`;
    expect(lint(rule, mixedRoutes, filename)).toContain('route');
  });

  it('blocks schema use outside a route definition file', () => {
    const serviceFile = 'apps/web/src/modules/billing/features/webhooks/application/handler.ts';
    expect(
      lint(
        rule,
        "import { ProviderEvent } from '../../../../../../../packages/contracts/src/billing/webhooks/provider-event'; ProviderEvent.parse(payload);",
        serviceFile,
      ),
    ).toContain('import');
    expect(lint(rule, validRoute, serviceFile)).toContain('import');
  });

  it('does not trust a same-named local helper in place of the HTTP pipeline', () => {
    const fakeHelper = `
      import { ProviderEvent } from '../../../../../../../packages/contracts/src/billing/webhooks/provider-event';
      const defineRoute = (value) => value;
      export const POST = defineRoute({ auth: { kind: 'webhook' }, input: { body: ProviderEvent } });
    `;
    expect(lint(rule, fakeHelper, filename)).toContain('route');
  });

  it('rejects defineRoute imports from a lookalike platform/http path', () => {
    const fakeHttpPath = `
      import { defineRoute } from '../../../../platform/http';
      import { ProviderEvent } from '../../../../../../../packages/contracts/src/billing/webhooks/provider-event';
      export const POST = defineRoute({ auth: { kind: 'webhook' }, input: { body: ProviderEvent } });
    `;
    expect(lint(rule, fakeHttpPath, filename)).toContain('route');
  });

  it('prevents webhook payloads from escaping through a contracts barrel', () => {
    expect(
      lint(
        rule,
        "export { ProviderEvent } from './billing/webhooks';",
        'packages/contracts/src/index.ts',
      ),
    ).toContain('import');
    expect(
      lint(
        rule,
        "export { ProviderEvent } from './provider-event';",
        'packages/contracts/src/billing/webhooks/index.ts',
      ),
    ).toEqual([]);
  });

  it('rejects dynamic webhook imports even in route-definition files', () => {
    expect(
      lint(
        rule,
        "const provider = await import('../../contracts/src/billing/webhooks'); void provider;",
        filename,
      ),
    ).toContain('import');
  });

  it('fails closed for non-literal dynamic imports in route-definition files', () => {
    expect(
      lint(
        rule,
        'const schemaPath = getWebhookPath(); const provider = await import(schemaPath); void provider;',
        filename,
      ),
    ).toContain('dynamic');
  });

  it('fails closed for dynamic imports and require calls anywhere in app source', () => {
    const payloadPath = 'apps/web/src/modules/identity/features/session/application/payload.ts';
    const packageSource =
      "const modulePath = '@base-app/contracts/webhooks/provider'; export const schema = import(modulePath);";
    expect(lint(rule, packageSource, payloadPath)).toContain('dynamic');
    expect(
      lint(
        rule,
        "const modulePath = '@base-app/contracts/webhooks/provider'; export const schema = require(modulePath);",
        payloadPath,
      ),
    ).toContain('dynamic');
  });

  it('does not block nonliteral dynamic imports outside app source', () => {
    expect(
      lint(
        rule,
        'const implementation = await import(modulePath); void implementation;',
        'packages/tooling/src/security/loader.ts',
      ),
    ).toEqual([]);
  });
});
