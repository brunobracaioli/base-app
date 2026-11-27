import type { AuthErrorKey, Result, SessionSummary } from '../../../extensions/types';

export type IdentityTokenInput = {
  readonly provider: string;
  readonly token: string;
  readonly nonce?: string;
};

export type EmailChangeOtpInput = {
  readonly email: string;
  readonly token: string;
};

export type LinkIdentityInput = {
  readonly provider: string;
};

export type UnlinkIdentityInput = {
  readonly identityId: string;
};

export interface CapturedPreviousSessionPort {
  getAccessToken(): Promise<string | null>;
  signOutLocal(): Promise<void>;
}

export interface AuthOperationsPort {
  signInAnonymously(captchaToken: string | undefined): Promise<Result<void, AuthErrorKey>>;
  signInWithIdToken(
    input: IdentityTokenInput,
    captchaToken: string | undefined,
  ): Promise<Result<void, AuthErrorKey>>;
  linkIdentity(
    input: LinkIdentityInput,
    captchaToken: string | undefined,
  ): Promise<Result<void, AuthErrorKey>>;
  unlinkIdentity(input: UnlinkIdentityInput): Promise<Result<void, AuthErrorKey>>;
  updateEmail(email: string): Promise<Result<void, AuthErrorKey>>;
  verifyEmailChangeOtp(input: EmailChangeOtpInput): Promise<Result<void, AuthErrorKey>>;
  refreshSession(): Promise<Result<void, AuthErrorKey>>;
  signOutEverywhere(): Promise<Result<void, AuthErrorKey>>;
}

export interface SessionPort {
  getCurrentAccessToken(): Promise<string | null>;
  getSessionSummary(): SessionSummary | null;
  subscribe(listener: () => void): () => void;
  revalidate?(): Promise<Result<void, AuthErrorKey>>;
  signOutLocal(): Promise<void>;
  capturePreviousSession(): Promise<CapturedPreviousSessionPort | null>;
}

export const unavailableSessionPort: SessionPort = {
  getCurrentAccessToken: async () => null,
  getSessionSummary: () => null,
  subscribe: () => () => undefined,
  signOutLocal: async () => undefined,
  capturePreviousSession: async () => null,
};

export const unavailableAuthOperations: AuthOperationsPort = {
  signInAnonymously: async () => ({ ok: false, error: 'auth.unavailable' }),
  signInWithIdToken: async () => ({ ok: false, error: 'auth.unavailable' }),
  linkIdentity: async () => ({ ok: false, error: 'auth.unavailable' }),
  unlinkIdentity: async () => ({ ok: false, error: 'auth.unavailable' }),
  updateEmail: async () => ({ ok: false, error: 'auth.unavailable' }),
  verifyEmailChangeOtp: async () => ({ ok: false, error: 'auth.unavailable' }),
  refreshSession: async () => ({ ok: false, error: 'auth.unavailable' }),
  signOutEverywhere: async () => ({ ok: false, error: 'auth.unavailable' }),
};
