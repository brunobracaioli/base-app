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
