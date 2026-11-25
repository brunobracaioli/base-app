import { LocaleKeyParityError, validateLocaleKeyParity } from './check-locale-parity';
import { resolveLocale } from './index';

describe('locale key parity', () => {
  it('accepts matching keys and rejects a missing Spanish key', () => {
    const locales = {
      'pt-BR': { common: { ok: 'OK', cancel: 'Cancelar' } },
      en: { common: { ok: 'OK', cancel: 'Cancel' } },
      es: { common: { ok: 'Aceptar', cancel: 'Cancelar' } },
    };
    expect(() => validateLocaleKeyParity(locales)).not.toThrow();

    const invalid = {
      ...locales,
      es: { common: { ok: 'Aceptar' } },
    };
    expect(() => validateLocaleKeyParity(invalid)).toThrow(LocaleKeyParityError);
  });
});

describe('locale selection', () => {
  it('uses profile, then device, then product default and maps supported language subtags', () => {
    expect(resolveLocale('es', 'en-US', 'pt-BR')).toBe('es');
    expect(resolveLocale(null, 'en-US', 'pt-BR')).toBe('en');
    expect(resolveLocale(undefined, 'pt-PT', 'en')).toBe('pt-BR');
    expect(resolveLocale(undefined, undefined, 'es')).toBe('es');
  });
});
