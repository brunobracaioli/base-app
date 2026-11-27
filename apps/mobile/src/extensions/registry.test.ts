import { z } from 'zod';
import { composeMobileExtensions, MobileExtensionError } from './registry';
import type { MobileExtension } from './types';

const namespace = {
  name: 'fake',
  resources: {
    'pt-BR': { label: 'Configuração falsa' },
    en: { label: 'Fake settings' },
    es: { label: 'Configuración falsa' },
  },
} as const;

const fakeExtension: MobileExtension = {
  name: 'sample-extension',
  bootGates: [{ name: 'sample-gate', evaluate: () => ({ status: 'pass' }) }],
  settingsItems: [{ id: 'sample', section: 'extensions', Component: () => null }],
  i18nNamespaces: [namespace],
};

describe('mobile extension composition', () => {
  it('accepts no extensions and composes a fake extension in declaration order', () => {
    expect(composeMobileExtensions([], {})).toMatchObject({
      authMethods: [],
      bootGates: [],
      settingsItems: [],
      providers: [],
      i18nNamespaces: [],
      captchaProvider: null,
    });
    expect(composeMobileExtensions([fakeExtension], {})).toMatchObject({
      bootGates: [fakeExtension.bootGates?.[0]],
      settingsItems: [fakeExtension.settingsItems?.[0]],
      i18nNamespaces: [namespace],
    });
  });

  it('fails closed when two extensions provide CAPTCHA', () => {
    const first: MobileExtension = {
      name: 'first-extension',
      captchaProvider: {
        kind: 'first',
        prewarm: jest.fn(),
        getToken: jest.fn(),
        release: jest.fn(),
        dispose: jest.fn(),
      },
    };
    const second: MobileExtension = {
      name: 'second-extension',
      captchaProvider: {
        kind: 'second',
        prewarm: jest.fn(),
        getToken: jest.fn(),
        release: jest.fn(),
        dispose: jest.fn(),
      },
    };

    expect(() => composeMobileExtensions([first, second], {})).toThrow(MobileExtensionError);
    expect(() => composeMobileExtensions([first, second], {})).toThrow(/captcha/i);
  });

  it.each([
    ['missing prefix', 'CAPTCHA_SITE_KEY'],
    ['secret marker', 'EXPO_PUBLIC_AUTH_SECRET'],
    ['private key marker', 'EXPO_PUBLIC_KEY_PRIVATE'],
    ['token marker', 'EXPO_PUBLIC_SESSION_TOKEN'],
    ['repeat core key', 'EXPO_PUBLIC_API_URL'],
  ])('rejects unsafe publicEnv key: %s', (_name, key) => {
    const invalid: MobileExtension = {
      name: 'unsafe-extension',
      publicEnv: z.object({ [key]: z.string().optional() }),
    };

    expect(() => composeMobileExtensions([invalid], {})).toThrow(MobileExtensionError);
  });

  it('accepts and validates a public CAPTCHA site key', () => {
    const extension: MobileExtension = {
      name: 'captcha-extension',
      publicEnv: z.object({ EXPO_PUBLIC_CAPTCHA_SITE_KEY: z.string().min(1) }),
    };

    expect(
      composeMobileExtensions([extension], { EXPO_PUBLIC_CAPTCHA_SITE_KEY: 'site-key' }).publicEnv,
    ).toEqual({ EXPO_PUBLIC_CAPTCHA_SITE_KEY: 'site-key' });
  });

  it('rejects public service URLs that would require cleartext traffic', () => {
    expect(() =>
      composeMobileExtensions([], { EXPO_PUBLIC_API_URL: 'http://api.example.invalid' }),
    ).toThrow(MobileExtensionError);
  });
});

describe('local development service URLs', () => {
  const globals = globalThis as unknown as { __DEV__: boolean };
  const originalDev = globals.__DEV__;

  afterEach(() => {
    globals.__DEV__ = originalDev;
  });

  it.each([
    'http://192.168.0.10:3000',
    'http://10.0.2.2:54321',
    'http://172.20.1.5:3000',
    'http://127.0.0.1:54321',
    'http://localhost:3000',
    'http://[::1]:3000',
  ])('accepts cleartext %s for a private host in a development bundle', (url) => {
    globals.__DEV__ = true;

    const publicEnv = composeMobileExtensions([], {
      EXPO_PUBLIC_API_URL: url,
      EXPO_PUBLIC_SUPABASE_URL: url,
    }).publicEnv;

    expect(publicEnv.EXPO_PUBLIC_API_URL).toBe(url);
    expect(publicEnv.EXPO_PUBLIC_SUPABASE_URL).toBe(url);
  });

  it.each([
    'http://api.example.invalid',
    'http://8.8.8.8:3000',
    'http://172.32.0.1:3000',
    'http://192.169.0.1:3000',
    'http://user:pass@192.168.0.10:3000',
    'http://192.168.0.10:3000/?token=x',
    'http://192.168.0.10:3000/#fragment',
  ])('rejects cleartext %s in a development bundle', (url) => {
    globals.__DEV__ = true;

    expect(() => composeMobileExtensions([], { EXPO_PUBLIC_API_URL: url })).toThrow(
      MobileExtensionError,
    );
  });

  it('rejects cleartext private hosts outside a development bundle', () => {
    globals.__DEV__ = false;

    expect(() =>
      composeMobileExtensions([], { EXPO_PUBLIC_API_URL: 'http://192.168.0.10:3000' }),
    ).toThrow(MobileExtensionError);
    expect(() =>
      composeMobileExtensions([], { EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' }),
    ).toThrow(MobileExtensionError);
  });

  it.each([true, false])('accepts HTTPS service URLs when __DEV__ is %s', (development) => {
    globals.__DEV__ = development;

    expect(
      composeMobileExtensions([], {
        EXPO_PUBLIC_API_URL: 'https://api.example.invalid',
        EXPO_PUBLIC_SUPABASE_URL: 'https://project.supabase.example',
      }).publicEnv.EXPO_PUBLIC_API_URL,
    ).toBe('https://api.example.invalid');
  });

  it('keeps the Sentry DSN HTTPS-only even in a development bundle', () => {
    globals.__DEV__ = true;

    expect(() =>
      composeMobileExtensions([], { EXPO_PUBLIC_SENTRY_DSN: 'http://192.168.0.10:9000/1' }),
    ).toThrow(MobileExtensionError);
  });
});

it('treats blank optional core values from the env example as unconfigured', () => {
  expect(
    composeMobileExtensions([], {
      EXPO_PUBLIC_API_URL: '',
      EXPO_PUBLIC_SENTRY_DSN: '  ',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '',
    }).publicEnv,
  ).toEqual({});
});
