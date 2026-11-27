import type { ConsentBodyInput, MeResponse, UpdateProfileBodyInput } from '@base-app/contracts';

import type { AuthErrorKey, Locale, Result, SessionSummary } from '../../../extensions/types';

export type AuthResult<T> = Result<T, AuthErrorKey>;
export type EmailCodePurpose = 'sign_in' | 'sign_up' | 'step_up';
export type AuthCodePurpose = 'sign_in' | 'sign_up' | 'recovery';
export type PasswordSetupPurpose = 'sign_up' | 'recovery';
export type PasswordChangePurpose = 'setup' | 'recovery' | 'change';
export type StepUpMethod = 'email_otp' | 'email_password';
export type EmailChangeAddress = 'old' | 'new';
export type SignOutScope = 'local' | 'global';
export type AuthFieldError =
  | 'invalid_email'
  | 'invalid_code'
  | 'password_too_short'
  | 'password_too_long'
  | 'password_requires_letter'
  | 'password_requires_digit';
export type FieldValidation<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AuthFieldError };

export interface AuthTransportPort {
  getCurrentAuthMethod(): StepUpMethod | null;
  getPendingPasswordSetup(): PasswordSetupPurpose | null;
  isRecentlyAuthenticated(maxAgeSeconds: number): boolean;
  sendEmailCode(input: {
    readonly email: string;
    readonly locale: Locale;
    readonly purpose: EmailCodePurpose;
    readonly resend?: boolean;
  }): Promise<AuthResult<void>>;
  verifyEmailCode(input: {
    readonly email: string;
    readonly code: string;
    readonly purpose: 'sign_in' | 'sign_up' | 'recovery';
  }): Promise<AuthResult<void>>;
  signInWithPassword(input: {
    readonly email: string;
    readonly password: string;
  }): Promise<AuthResult<void>>;
  sendPasswordResetCode(input: {
    readonly email: string;
    readonly locale: Locale;
    readonly resend?: boolean;
  }): Promise<AuthResult<void>>;
  sendPasswordChangeCode(input: {
    readonly email: string;
    readonly locale: Locale;
    readonly resend?: boolean;
  }): Promise<AuthResult<void>>;
  resendEmailChangeCode(input: {
    readonly email: string;
    readonly address: EmailChangeAddress;
  }): Promise<AuthResult<void>>;
  updatePassword(input: {
    readonly password: string;
    readonly purpose: PasswordChangePurpose;
    readonly nonce?: string;
  }): Promise<AuthResult<void>>;
  updateLocale(locale: Locale): Promise<AuthResult<void>>;
  beginEmailChange(input: { readonly email: string }): Promise<AuthResult<void>>;
  verifyEmailChangeCode(input: {
    readonly email: string;
    readonly code: string;
  }): Promise<AuthResult<void>>;
  stepUpWithPassword(input: {
    readonly email: string;
    readonly password: string;
    readonly expectedUserId: string;
  }): Promise<AuthResult<{ readonly sameUser: boolean }>>;
  verifyStepUpCode(input: {
    readonly email: string;
    readonly code: string;
    readonly expectedUserId: string;
  }): Promise<AuthResult<{ readonly sameUser: boolean }>>;
  signOut(scope: SignOutScope): Promise<AuthResult<void>>;
}

export interface AccountApiPort {
  getMe(): Promise<AuthResult<MeResponse>>;
  updateMe(input: UpdateProfileBodyInput): Promise<AuthResult<MeResponse>>;
  acceptConsent(input: ConsentBodyInput): Promise<AuthResult<void>>;
}

export interface IdentityLifecycleSink {
  onSignedIn(userId: string): void | Promise<void>;
  onSignedOut(userId: string | null): void | Promise<void>;
}

export type AuthFlowSnapshot =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'email_code';
      readonly purpose: AuthCodePurpose;
      readonly stage: 'code';
      readonly email: string;
      readonly resendAvailableAt: number;
    }
  | { readonly kind: 'password_sign_in'; readonly stage: 'credentials'; readonly email: string }
  | {
      readonly kind: 'password_setup';
      readonly purpose: PasswordSetupPurpose;
      readonly stage: 'new_password';
      readonly email: string | null;
    }
  | {
      readonly kind: 'password_change';
      readonly stage: 'code' | 'new_password';
      readonly resendAvailableAt: number | null;
    }
  | {
      readonly kind: 'email_change';
      readonly stage: 'verify_old' | 'verify_new';
      readonly oldEmail: string;
      readonly newEmail: string;
      readonly oldAddressVerified: boolean;
      readonly newAddressVerified: boolean;
      readonly resendAvailableAt: number;
    }
  | {
      readonly kind: 'step_up';
      readonly method: StepUpMethod;
      readonly stage: 'credentials' | 'code';
      readonly email: string;
      readonly resendAvailableAt: number | null;
    };

export type AuthAccessStatus = 'signed_out' | 'signed_in' | 'password_setup_required';

/** Safe UI state only. Access/refresh tokens, SDK sessions, codes, passwords and nonces stay adapter/controller-private. */
export interface AuthSnapshot {
  readonly accessStatus: AuthAccessStatus;
  readonly session: SessionSummary | null;
  readonly authMethod: StepUpMethod | null;
  readonly flow: AuthFlowSnapshot;
  readonly isBusy: boolean;
  readonly error: AuthErrorKey | null;
  readonly me: MeResponse | null;
  readonly needsConsent: readonly ('terms' | 'privacy')[];
  readonly resendSecondsRemaining: number;
}

export interface AuthController {
  getSnapshot(): AuthSnapshot;
  subscribe(listener: () => void): () => void;
  beginSignInWithCode(email: string): Promise<AuthResult<void>>;
  beginSignUp(email: string): Promise<AuthResult<void>>;
  signInWithPassword(email: string, password: string): Promise<AuthResult<void>>;
  beginPasswordRecovery(email: string): Promise<AuthResult<void>>;
  resendCode(address?: EmailChangeAddress): Promise<AuthResult<void>>;
  verifyCode(code: string): Promise<AuthResult<void>>;
  setPassword(password: string): Promise<AuthResult<void>>;
  beginPasswordChange(): Promise<AuthResult<void>>;
  hasRecentAuthentication(): boolean;
  stagePasswordChangeCode(code: string): Promise<AuthResult<void>>;
  changePassword(password: string): Promise<AuthResult<void>>;
  beginEmailChange(email: string): Promise<AuthResult<void>>;
  verifyEmailChangeCode(address: EmailChangeAddress, code: string): Promise<AuthResult<void>>;
  beginStepUp(method: StepUpMethod, email: string, password?: string): Promise<AuthResult<void>>;
  verifyStepUpCode(code: string): Promise<AuthResult<void>>;
  signOut(scope: SignOutScope): Promise<AuthResult<void>>;
  refreshMe(): Promise<AuthResult<MeResponse>>;
  updateProfile(input: UpdateProfileBodyInput): Promise<AuthResult<MeResponse>>;
  updateLocale(locale: Locale): Promise<AuthResult<MeResponse>>;
  acceptConsent(input: ConsentBodyInput): Promise<AuthResult<void>>;
  tick(): void;
  resetFlow(): void;
  dispose(): void;
}

export interface AuthControllerDependencies {
  readonly auth: AuthTransportPort;
  readonly account: AccountApiPort;
  readonly session: {
    getSessionSummary(): SessionSummary | null;
    subscribe(listener: () => void): () => void;
    revalidate?(): Promise<AuthResult<void>>;
  };
  readonly now: () => number;
  readonly locale: () => Locale;
  readonly recentAuthMaxAgeSec: () => number;
  readonly lifecycle?: IdentityLifecycleSink;
}
