import type { UserAuthContext } from '../authorization/types';

export type AuthFailure = {
  readonly code:
    'auth.invalid_token' | 'auth.token_expired' | 'auth.account_deleted' | 'auth.unavailable';
  readonly retryAfterSec?: number;
};

export type AuthVerificationResult =
  | { readonly ok: true; readonly value: UserAuthContext }
  | { readonly ok: false; readonly error: AuthFailure };
