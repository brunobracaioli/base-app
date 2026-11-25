import i18next, { type Resource } from 'i18next';
import { initReactI18next } from 'react-i18next';

import product from '@base-app/config/product.config';
import type { I18nNamespace, Locale } from '../../extensions/types';

import authEn from './locales/en/auth.json';
import billingEn from './locales/en/billing.json';
import commonEn from './locales/en/common.json';
import errorsEn from './locales/en/errors.json';
import gatesEn from './locales/en/gates.json';
import legalEn from './locales/en/legal.json';
import privacyEn from './locales/en/privacy.json';
import settingsEn from './locales/en/settings.json';
import authEs from './locales/es/auth.json';
import billingEs from './locales/es/billing.json';
import commonEs from './locales/es/common.json';
import errorsEs from './locales/es/errors.json';
import gatesEs from './locales/es/gates.json';
import legalEs from './locales/es/legal.json';
import privacyEs from './locales/es/privacy.json';
import settingsEs from './locales/es/settings.json';
import authPtBr from './locales/pt-BR/auth.json';
import billingPtBr from './locales/pt-BR/billing.json';
import commonPtBr from './locales/pt-BR/common.json';
import errorsPtBr from './locales/pt-BR/errors.json';
import gatesPtBr from './locales/pt-BR/gates.json';
import legalPtBr from './locales/pt-BR/legal.json';
import privacyPtBr from './locales/pt-BR/privacy.json';
import settingsPtBr from './locales/pt-BR/settings.json';

const coreResources: Resource = {
  'pt-BR': {
    common: commonPtBr,
    errors: errorsPtBr,
    auth: authPtBr,
    settings: settingsPtBr,
    billing: billingPtBr,
    privacy: privacyPtBr,
    gates: gatesPtBr,
    legal: legalPtBr,
  },
  en: {
    common: commonEn,
    errors: errorsEn,
    auth: authEn,
    settings: settingsEn,
    billing: billingEn,
    privacy: privacyEn,
    gates: gatesEn,
    legal: legalEn,
  },
  es: {
    common: commonEs,
    errors: errorsEs,
    auth: authEs,
    settings: settingsEs,
    billing: billingEs,
    privacy: privacyEs,
    gates: gatesEs,
    legal: legalEs,
  },
};

export function resolveLocale(
  profileLocale: string | null | undefined,
  deviceLocale: string | null | undefined,
  defaultLocale: Locale = product.defaultLocale as Locale,
): Locale {
  const supported: readonly Locale[] = ['pt-BR', 'en', 'es'];
  const match = (candidate: string | null | undefined): Locale | null => {
    if (candidate === null || candidate === undefined) {
      return null;
    }
    const normalized = candidate.replace('_', '-');
    const exact = supported.find((locale) => locale.toLowerCase() === normalized.toLowerCase());
    if (exact !== undefined) {
      return exact;
    }
    const language = normalized.split('-')[0]?.toLowerCase();
    if (language === 'pt') {
      return 'pt-BR';
    }
    return supported.find((locale) => locale.toLowerCase() === language) ?? null;
  };

  return match(profileLocale) ?? match(deviceLocale) ?? defaultLocale;
}

export function createMobileI18n(
  locale: Locale,
  extensionNamespaces: readonly I18nNamespace[] = [],
) {
  const resources: Resource = {
    'pt-BR': { ...coreResources['pt-BR'] },
    en: { ...coreResources.en },
    es: { ...coreResources.es },
  };
  for (const extension of extensionNamespaces) {
    for (const language of ['pt-BR', 'en', 'es'] as const) {
      resources[language] ??= {};
      resources[language]![extension.name] = extension.resources[language];
    }
  }

  const instance = i18next.createInstance();
  instance.use(initReactI18next);
  void instance.init({
    resources,
    lng: locale,
    fallbackLng: product.defaultLocale,
    defaultNS: 'common',
    ns: [
      'common',
      'errors',
      'auth',
      'settings',
      'billing',
      'privacy',
      'gates',
      'legal',
      ...extensionNamespaces.map((entry) => entry.name),
    ],
    initAsync: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return instance;
}

let activeI18n: ReturnType<typeof createMobileI18n> = createMobileI18n(
  product.defaultLocale as Locale,
);

export function setActiveMobileI18n(instance: ReturnType<typeof createMobileI18n>): void {
  activeI18n = instance;
}

export function translateMobile(key: string, options?: Readonly<Record<string, string>>): string {
  if (key.startsWith('errors.')) {
    const requestedErrorKey = key.slice('errors.'.length);
    const errorKey = activeI18n.exists(requestedErrorKey, { ns: 'errors' })
      ? requestedErrorKey
      : 'unknown';
    return options === undefined
      ? activeI18n.t(errorKey, { ns: 'errors' })
      : activeI18n.t(errorKey, { ...options, ns: 'errors' });
  }
  return options === undefined ? activeI18n.t(key) : activeI18n.t(key, options);
}
