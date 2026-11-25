import type { ComponentType, ReactNode } from 'react';
import type { ProductConfig } from '@base-app/config';
import type * as z from 'zod';

export type Locale = 'pt-BR' | 'en' | 'es';
export type AuthErrorKey =
  'auth.unavailable' | 'auth.failed' | 'auth.session_expired' | 'auth.session_missing';

export type Result<T, E extends string> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export type SessionSummary = {
  readonly userId: string;
  readonly isAnonymous: boolean;
};

export type BootProfileSummary = {
  readonly termsAccepted: boolean;
  readonly locale?: Locale;
};

export type BootContext = {
  readonly config: ProductConfig;
  readonly session: SessionSummary | null;
  readonly me: BootProfileSummary | null;
};

export type BootGateResult =
  { readonly status: 'pass' } | { readonly status: 'block'; readonly href: string };

export interface BootGate {
  readonly name: string;
  evaluate(context: BootContext): BootGateResult | Promise<BootGateResult>;
}

export type AuthMethodProps = {
  readonly locale: Locale;
  readonly busy: boolean;
  setBusy(busy: boolean): void;
  onError(key: AuthErrorKey): void;
  signInWithIdToken(input: {
    provider: string;
    token: string;
    nonce?: string;
  }): Promise<Result<void, AuthErrorKey>>;
};

export type AuthMethodEntry = {
  readonly id: string;
  readonly Component: ComponentType<AuthMethodProps>;
};

export type SettingsItemProps = {
  readonly session: SessionSummary;
  navigate(route: string): void;
};

export type SettingsItem = {
  readonly id: string;
  readonly section: 'extensions';
  readonly Component: ComponentType<SettingsItemProps>;
};

export type ProviderComponent = ComponentType<{ readonly children: ReactNode }>;

export type I18nNamespace = {
  readonly name: string;
  readonly resources: Readonly<Record<Locale, Record<string, unknown>>>;
};

export type CaptchaAction =
  | 'sign_up'
  | 'sign_in_password'
  | 'sign_in_otp'
  | 'reset_password'
  | 'anonymous'
  | 'resend'
  | 'reauth'
  | 'social';

export type CaptchaToken = {
  readonly token: string;
  readonly issuedAt: number;
};

export type CaptchaErrorCode = 'unavailable' | 'cancelled' | 'timeout' | 'failed';

export class CaptchaError extends Error {
  constructor(readonly code: CaptchaErrorCode) {
    super(code);
    this.name = 'CaptchaError';
  }
}

export interface CaptchaProvider {
  readonly kind: string;
  prewarm(action: CaptchaAction): void;
  getToken(action: CaptchaAction): Promise<CaptchaToken>;
  release(token: CaptchaToken): void;
  dispose(): void;
}

export interface MobileExtension {
  readonly name: string;
  readonly authMethods?: readonly AuthMethodEntry[];
  readonly bootGates?: readonly BootGate[];
  readonly settingsItems?: readonly SettingsItem[];
  readonly providers?: readonly ProviderComponent[];
  readonly i18nNamespaces?: readonly I18nNamespace[];
  readonly captchaProvider?: CaptchaProvider;
  readonly publicEnv?: z.ZodObject<z.ZodRawShape>;
}
