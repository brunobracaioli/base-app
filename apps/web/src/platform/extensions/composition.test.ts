import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import type { DomainEvent, ServerExtension, SiteExtension } from './types';
import { composeServerExtensions, composeSiteExtensions } from './composition';
import { composePlatformRuntime } from '../composition/index';
import { GET as fakeExtensionRoute } from '../testing/fixtures/extensions/fake-extension/route';
import type { EmailSender } from './ports';

type FixtureEvent = DomainEvent & { readonly type: 'fixture.changed'; readonly value: string };

describe('extension composition', () => {
  it('works with empty server and site extension lists', () => {
    const server = composeServerExtensions([]);
    const site = composeSiteExtensions([], {});
    expect(server.extensionSystemRoles).toEqual([]);
    expect(server.overrides).toEqual({});
    expect(site.captchaWidget).toBeUndefined();
    expect(site.publicEnvironment).toEqual({});
  });

  it('composes a handler, a filesystem route using defineRoute, and one port override', async () => {
    const eventValues: string[] = [];
    const sender: EmailSender = { async send() {} };
    const extension: ServerExtension = {
      name: 'fake-extension',
      systemRoles: ['fake_extension_system'],
      overrides: { EmailSender: sender },
      register(registry) {
        registry.onEvent<FixtureEvent>('fixture.changed', async (event) => {
          eventValues.push(event.value);
        });
      },
    };
    const composition = composeServerExtensions([extension]);
    await composition.dispatchEvent({
      type: 'fixture.changed',
      value: 'handled',
      occurredAt: '2026-11-24T12:00:00.000Z',
      correlationId: '00000000-0000-7000-8000-000000000001',
    });
    expect(composition.extensionSystemRoles).toEqual(['fake_extension_system']);
    expect(composition.overrides.EmailSender).toBe(sender);
    expect(eventValues).toEqual(['handled']);

    const response = await fakeExtensionRoute(new Request('https://localhost/fixture'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('passes validated extension roles to the platform database factory', async () => {
    const extension = {
      name: 'catalog',
      systemRoles: ['catalog_system'],
      register() {},
    } satisfies ServerExtension;
    const composition = composeServerExtensions([extension]);
    const received: string[][] = [];
    const databaseUrls: string[] = [];
    const runtime = composePlatformRuntime({
      extensionComposition: composition,
      environment: {
        APP_HOST: 'localhost:3000',
        DATABASE_URL: 'postgresql://db.example:6543/test',
        DATABASE_CA_CERT: 'test-only-ca-certificate',
      },
      createDatabase(databaseEnvironment, options) {
        databaseUrls.push(databaseEnvironment.DATABASE_URL);
        received.push([...options.extensionSystemRoles]);
        return 'database';
      },
    });
    expect(received).toEqual([['catalog_system']]);
    expect(databaseUrls).toEqual(['postgresql://db.example:6543/test']);
    expect(runtime.database).toBe('database');
  });

  it('fails boot when two extensions override the same port', () => {
    const first: ServerExtension = {
      name: 'first',
      register(registry) {
        registry.override('EmailSender', { async send() {} });
      },
    };
    const second: ServerExtension = {
      name: 'second',
      register(registry) {
        registry.override('EmailSender', { async send() {} });
      },
    };
    expect(() => composeServerExtensions([first, second])).toThrow(/Port already overridden/);
  });

  it('reserves core export section names during extension composition', () => {
    const reservedNames: readonly ServerExtension[] = [
      'account',
      'profile',
      'consents',
      'entitlements',
    ].map((name) => ({
      name: `extension-${name}`,
      register(registry) {
        registry.addExportSection(name, {
          schema: z.unknown(),
          async collect() {
            return {};
          },
        });
      },
    }));
    for (const extension of reservedNames) {
      expect(() => composeServerExtensions([extension])).toThrow(/reserved by the core/);
    }
    for (const name of ['exportedAt', 'auditEvents']) {
      const extension: ServerExtension = {
        name: `extension-${name.toLowerCase()}`,
        register(registry) {
          registry.addExportSection(name, {
            schema: z.unknown(),
            async collect() {
              return {};
            },
          });
        },
      };
      expect(() => composeServerExtensions([extension])).toThrow(/reserved by the core/);
    }
  });

  it('rejects duplicate CAPTCHA widgets and invalid public environment names', () => {
    const widget: NonNullable<SiteExtension['captchaWidget']> = () => null;
    expect(() =>
      composeSiteExtensions(
        [
          { name: 'captcha-one', captchaWidget: widget },
          { name: 'captcha-two', captchaWidget: widget },
        ],
        {},
      ),
    ).toThrow(/Only one site extension/);

    expect(() =>
      composeSiteExtensions(
        [{ name: 'invalid-env', publicEnv: z.strictObject({ API_KEY: z.string() }) }],
        { API_KEY: 'public-looking-value' },
      ),
    ).toThrow(/Invalid public site environment key/);
    expect(() =>
      composeSiteExtensions(
        [
          {
            name: 'invalid-secret-name',
            publicEnv: z.strictObject({ NEXT_PUBLIC_TOKEN: z.string() }),
          },
        ],
        { NEXT_PUBLIC_TOKEN: 'generated-test-only-value' },
      ),
    ).toThrow(/Invalid public site environment key/);
  });

  it('validates the public site environment allowlist and collision behavior', () => {
    const site = composeSiteExtensions(
      [
        {
          name: 'captcha',
          publicEnv: z.strictObject({ NEXT_PUBLIC_CAPTCHA_SITE_KEY: z.string().min(1) }),
        },
      ],
      { NEXT_PUBLIC_CAPTCHA_SITE_KEY: 'test-only-public-site-key' },
      ['NEXT_PUBLIC_CORE_FLAG'],
    );
    expect(site.publicEnvironment).toEqual({
      NEXT_PUBLIC_CAPTCHA_SITE_KEY: 'test-only-public-site-key',
    });
    expect(() =>
      composeSiteExtensions(
        [{ name: 'duplicate', publicEnv: z.strictObject({ NEXT_PUBLIC_CORE_FLAG: z.string() }) }],
        { NEXT_PUBLIC_CORE_FLAG: 'test-only-value' },
        ['NEXT_PUBLIC_CORE_FLAG'],
      ),
    ).toThrow(/collision/);
  });

  it('fails closed when a purge authorization issuer is not provided', () => {
    let handle:
      ReturnType<Parameters<ServerExtension['register']>[0]['registerPurgeJob']> | undefined;
    const extension: ServerExtension = {
      name: 'retention',
      register(registry) {
        handle = registry.registerPurgeJob({
          name: 'expire-accounts',
          reasons: ['scheduled'],
          maxPerMinute: 5,
        });
      },
    };
    composeServerExtensions([extension]);
    expect(() => handle?.authorize('11111111-1111-4111-8111-111111111111', 'scheduled')).toThrow(
      /Purge authorization is unavailable/,
    );
  });
});
