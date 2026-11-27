import type { MeResponse, UpdateProfileBodyInput } from '@base-app/contracts';

import type { AuthErrorKey, SessionSummary } from '../../../extensions/types';
import type {
  AccountApiPort,
  AuthControllerDependencies,
  AuthResult,
  AuthTransportPort,
  PasswordSetupPurpose,
} from './auth-contracts';
import {
  createAuthController,
  normalizeEmail,
  validateOtpCode,
  validatePassword,
} from './auth-controller';

const initialMe: MeResponse = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  email: 'person@example.com',
  displayName: 'Person',
  locale: 'en',
  createdAt: '2026-11-26T00:00:00.000Z',
  consents: { needsAcceptance: ['terms', 'privacy'] },
};

const userSession: SessionSummary = { userId: initialMe.id, isAnonymous: false };
const success = <T>(value: T): AuthResult<T> => ({ ok: true, value });
const failure = <T>(error: AuthErrorKey = 'auth.failed'): AuthResult<T> => ({ ok: false, error });

function createFixture(options?: {
  readonly session?: SessionSummary | null;
  readonly method?: 'email_otp' | 'email_password' | null;
  readonly recent?: boolean;
  readonly pendingSetup?: PasswordSetupPurpose | null;
}) {
  const callOrder: string[] = [];
  let now = 1_000_000;
  let currentMe = initialMe;
  let pendingPasswordSetup = options?.pendingSetup ?? null;
  let session = options?.session ?? null;
  const sessionListeners = new Set<() => void>();
  const setSession = (next: SessionSummary | null): void => {
    session = next;
    for (const listener of sessionListeners) listener();
  };

  const auth: jest.Mocked<AuthTransportPort> = {
    getCurrentAuthMethod: jest.fn().mockReturnValue(options?.method ?? null),
    getPendingPasswordSetup: jest.fn(() => pendingPasswordSetup),
    isRecentlyAuthenticated: jest.fn().mockReturnValue(options?.recent ?? true),
    sendEmailCode: jest.fn().mockResolvedValue(success(undefined)),
    verifyEmailCode: jest.fn().mockImplementation(async ({ purpose }) => {
      if (purpose === 'sign_in') setSession(userSession);
      else pendingPasswordSetup = purpose;
      return success(undefined);
    }),
    signInWithPassword: jest.fn().mockImplementation(async () => {
      setSession(userSession);
      return success(undefined);
    }),
    sendPasswordResetCode: jest.fn().mockResolvedValue(success(undefined)),
    sendPasswordChangeCode: jest.fn().mockResolvedValue(success(undefined)),
    resendEmailChangeCode: jest.fn().mockResolvedValue(success(undefined)),
    updatePassword: jest.fn().mockImplementation(async ({ purpose }) => {
      if (purpose !== 'change') {
        pendingPasswordSetup = null;
        setSession(userSession);
      }
      return success(undefined);
    }),
    updateLocale: jest.fn().mockResolvedValue(success(undefined)),
    beginEmailChange: jest.fn().mockResolvedValue(success(undefined)),
    verifyEmailChangeCode: jest.fn().mockResolvedValue(success(undefined)),
    stepUpWithPassword: jest.fn().mockResolvedValue(success({ sameUser: true })),
    verifyStepUpCode: jest.fn().mockResolvedValue(success({ sameUser: true })),
    signOut: jest.fn().mockImplementation(async () => {
      setSession(null);
      return success(undefined);
    }),
  };

  const account: jest.Mocked<AccountApiPort> = {
    getMe: jest.fn().mockImplementation(async () => {
      callOrder.push('getMe');
      return success(currentMe);
    }),
    updateMe: jest.fn().mockImplementation(async (input: UpdateProfileBodyInput) => {
      currentMe = {
        ...currentMe,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.locale === undefined ? {} : { locale: input.locale }),
      };
      return success(currentMe);
    }),
    acceptConsent: jest.fn().mockResolvedValue(success(undefined)),
  };

  const revalidateSession = jest.fn(async (): Promise<AuthResult<void>> => {
    callOrder.push('revalidate');
    return success(undefined);
  });

  const dependencies: AuthControllerDependencies = {
    auth,
    account,
    session: {
      getSessionSummary: () => session,
      subscribe: (listener) => {
        sessionListeners.add(listener);
        return () => sessionListeners.delete(listener);
      },
      revalidate: revalidateSession,
    },
    now: () => now,
    locale: () => 'en',
    recentAuthMaxAgeSec: () => 300,
  };

  return {
    auth,
    account,
    revalidateSession,
    callOrder,
    controller: createAuthController(dependencies),
    getMe: () => currentMe,
    getSession: () => session,
    setMe: (value: MeResponse) => {
      currentMe = value;
    },
    setNow: (value: number) => {
      now = value;
    },
    setSession,
  };
}

describe('auth model validation', () => {
  it('normalizes email and validates OTP/password policy with stable field errors', () => {
    expect(normalizeEmail('  Person@Example.com ')).toEqual({
      ok: true,
      value: 'person@example.com',
    });
    expect(normalizeEmail('not-an-email')).toEqual({ ok: false, error: 'invalid_email' });
    expect(validateOtpCode(' 0123456789 ')).toEqual({ ok: true, value: '0123456789' });
    expect(validateOtpCode('123456789')).toEqual({ ok: false, error: 'invalid_code' });
    expect(validateOtpCode('123456789x')).toEqual({ ok: false, error: 'invalid_code' });

    expect(validatePassword('short1')).toEqual({ ok: false, error: 'password_too_short' });
    expect(validatePassword('abcdefghij')).toEqual({ ok: false, error: 'password_requires_digit' });
    expect(validatePassword('1234567890')).toEqual({
      ok: false,
      error: 'password_requires_letter',
    });
    expect(validatePassword(`A1${'é'.repeat(35)}`).ok).toBe(true);
    expect(validatePassword(`A1${'é'.repeat(36)}`)).toEqual({
      ok: false,
      error: 'password_too_long',
    });
    expect(validatePassword('Password123').ok).toBe(true);
  });
});

describe('auth controller', () => {
  it('revalidates the session before reading the profile and stops on transient auth failure', async () => {
    const fixture = createFixture({ session: userSession });

    await expect(fixture.controller.refreshMe()).resolves.toEqual(success(initialMe));
    expect(fixture.callOrder).toEqual(['revalidate', 'getMe']);

    fixture.callOrder.length = 0;
    fixture.account.getMe.mockClear();
    fixture.revalidateSession.mockResolvedValueOnce(failure('auth.unavailable'));
    await expect(fixture.controller.refreshMe()).resolves.toEqual(failure('auth.unavailable'));
    expect(fixture.revalidateSession).toHaveBeenCalledTimes(2);
    expect(fixture.callOrder).toEqual([]);
    expect(fixture.account.getMe).not.toHaveBeenCalled();
  });

  it('keeps signup OTP sessions behind the password setup gate until password creation succeeds', async () => {
    const fixture = createFixture();
    const { controller, auth } = fixture;

    expect(await controller.beginSignUp(' Person@Example.com ')).toEqual(success(undefined));
    expect(auth.sendEmailCode).toHaveBeenCalledWith({
      email: 'person@example.com',
      locale: 'en',
      purpose: 'sign_up',
    });
    expect(controller.getSnapshot().flow).toMatchObject({ kind: 'email_code', purpose: 'sign_up' });

    expect(await controller.verifyCode('0123456789')).toEqual(success(undefined));
    expect(auth.verifyEmailCode).toHaveBeenCalledWith({
      email: 'person@example.com',
      code: '0123456789',
      purpose: 'sign_up',
    });
    expect(controller.getSnapshot().accessStatus).toBe('password_setup_required');
    controller.resetFlow();
    expect(controller.getSnapshot().accessStatus).toBe('password_setup_required');

    expect(await controller.setPassword('Password123')).toEqual(success(undefined));
    expect(auth.updatePassword).toHaveBeenCalledWith({ password: 'Password123', purpose: 'setup' });
    expect(controller.getSnapshot()).toMatchObject({
      accessStatus: 'signed_in',
      authMethod: 'email_password',
      flow: { kind: 'idle' },
    });
  });

  it('keeps recovery sessions behind the same password setup gate', async () => {
    const fixture = createFixture();
    const { controller, auth } = fixture;

    expect(await controller.beginPasswordRecovery('PERSON@example.com')).toEqual(
      success(undefined),
    );
    expect(auth.sendPasswordResetCode).toHaveBeenCalledWith({
      email: 'person@example.com',
      locale: 'en',
    });
    expect(controller.getSnapshot().flow).toMatchObject({
      kind: 'email_code',
      purpose: 'recovery',
    });

    expect(await controller.verifyCode('0123456789')).toEqual(success(undefined));
    expect(controller.getSnapshot().accessStatus).toBe('password_setup_required');
    expect(await controller.setPassword('Recovery123')).toEqual(success(undefined));
    expect(auth.updatePassword).toHaveBeenCalledWith({
      password: 'Recovery123',
      purpose: 'recovery',
    });
    expect(controller.getSnapshot().accessStatus).toBe('signed_in');
  });

  it('rehydrates an in-memory pending setup session without persisting email or credentials', async () => {
    const fixture = createFixture({
      session: null,
      method: 'email_password',
      pendingSetup: 'recovery',
    });
    const { controller } = fixture;

    expect(controller.getSnapshot()).toMatchObject({
      accessStatus: 'password_setup_required',
      flow: {
        kind: 'password_setup',
        purpose: 'recovery',
        email: null,
      },
    });
    controller.resetFlow();
    expect(controller.getSnapshot().accessStatus).toBe('password_setup_required');
    expect(await controller.refreshMe()).toEqual(failure('auth.session_missing'));
    expect(fixture.account.getMe).not.toHaveBeenCalled();
    expect(await controller.setPassword('Recovery123')).toEqual(success(undefined));
    expect(controller.getSnapshot().accessStatus).toBe('signed_in');
  });

  it('enforces the injected cooldown and keeps unknown auth responses generic', async () => {
    const fixture = createFixture();
    const { controller, auth, setNow } = fixture;
    auth.sendEmailCode.mockResolvedValueOnce(failure('auth.failed'));
    expect(await controller.beginSignInWithCode('person@example.com')).toEqual(failure());
    expect(controller.getSnapshot().error).toBe('auth.failed');

    expect(await controller.beginSignInWithCode('person@example.com')).toEqual(success(undefined));
    expect(controller.getSnapshot().resendSecondsRemaining).toBe(60);
    expect(await controller.resendCode()).toEqual(failure());
    expect(auth.sendEmailCode).toHaveBeenCalledTimes(2);

    setNow(1_060_000);
    expect(await controller.resendCode()).toEqual(success(undefined));
    expect(auth.sendEmailCode).toHaveBeenLastCalledWith({
      email: 'person@example.com',
      locale: 'en',
      purpose: 'sign_in',
      resend: true,
    });
  });

  it('caches external-store snapshots until publish or the injected-clock tick', async () => {
    const fixture = createFixture();
    const { controller, setNow } = fixture;
    await controller.beginSignInWithCode('person@example.com');

    const first = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(first);
    setNow(1_001_000);
    controller.tick();
    const updated = controller.getSnapshot();
    expect(updated).not.toBe(first);
    expect(updated.resendSecondsRemaining).toBe(59);
    expect(controller.getSnapshot()).toBe(updated);
  });

  it('ignores stale concurrent responses and keeps the latest email flow', async () => {
    const fixture = createFixture();
    const pendingSends: Array<(result: AuthResult<void>) => void> = [];
    fixture.auth.sendEmailCode.mockImplementation(
      () => new Promise<AuthResult<void>>((resolve) => pendingSends.push(resolve)),
    );

    const first = fixture.controller.beginSignInWithCode('first@example.com');
    const second = fixture.controller.beginSignInWithCode('second@example.com');
    pendingSends[1]?.(success(undefined));
    expect(await second).toEqual(success(undefined));
    pendingSends[0]?.(success(undefined));

    expect(await first).toEqual(failure());
    expect(fixture.controller.getSnapshot().flow).toMatchObject({
      kind: 'email_code',
      email: 'second@example.com',
    });
  });

  it('stages password reauthentication code privately and never replays a failed mutation', async () => {
    const fixture = createFixture({ session: userSession, method: 'email_password' });
    const { controller, auth } = fixture;
    auth.updatePassword.mockResolvedValueOnce(failure()).mockResolvedValueOnce(success(undefined));

    expect(await controller.beginPasswordChange()).toEqual(success(undefined));
    expect(auth.isRecentlyAuthenticated).toHaveBeenCalledWith(300);
    expect(controller.getSnapshot().flow).toMatchObject({ kind: 'password_change', stage: 'code' });
    expect(await controller.stagePasswordChangeCode('0123456789')).toEqual(success(undefined));
    expect(controller.getSnapshot().flow).toMatchObject({
      kind: 'password_change',
      stage: 'new_password',
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('0123456789');
    expect(auth.updatePassword).not.toHaveBeenCalled();

    expect(await controller.changePassword('NewPassword123')).toEqual(failure());
    expect(auth.updatePassword).toHaveBeenCalledTimes(1);
    expect(auth.updatePassword).toHaveBeenLastCalledWith({
      password: 'NewPassword123',
      purpose: 'change',
      nonce: '0123456789',
    });
    expect(controller.getSnapshot().flow).toMatchObject({ kind: 'password_change', stage: 'code' });

    expect(await controller.stagePasswordChangeCode('9876543210')).toEqual(success(undefined));
    expect(await controller.changePassword('NewPassword123')).toEqual(success(undefined));
    expect(auth.updatePassword).toHaveBeenCalledTimes(2);
    expect(auth.updatePassword).toHaveBeenLastCalledWith({
      password: 'NewPassword123',
      purpose: 'change',
      nonce: '9876543210',
    });
  });

  it('requires recent auth and both email confirmations before accepting an email change', async () => {
    const fixture = createFixture({ session: userSession, method: 'email_otp', recent: false });
    const { controller, auth, setMe } = fixture;

    expect(controller.hasRecentAuthentication()).toBe(false);
    expect(await controller.beginEmailChange('new@example.com')).toEqual(failure());
    expect(auth.isRecentlyAuthenticated).toHaveBeenCalledWith(300);
    expect(auth.beginEmailChange).not.toHaveBeenCalled();

    auth.isRecentlyAuthenticated.mockReturnValue(true);
    let newAddressVerified = false;
    auth.verifyEmailChangeCode.mockImplementation(async ({ email }) => {
      if (email === 'new@example.com') newAddressVerified = true;
      if (newAddressVerified) setMe({ ...initialMe, email: 'new@example.com' });
      return success(undefined);
    });
    expect(await controller.beginEmailChange('NEW@example.com')).toEqual(success(undefined));
    const flow = controller.getSnapshot().flow;
    expect(flow).toMatchObject({
      kind: 'email_change',
      oldEmail: 'person@example.com',
      newEmail: 'new@example.com',
      stage: 'verify_old',
    });

    expect(await controller.verifyEmailChangeCode('old', '0123456789')).toEqual(success(undefined));
    expect(controller.getSnapshot().flow).toMatchObject({
      kind: 'email_change',
      oldAddressVerified: true,
      newAddressVerified: false,
      stage: 'verify_new',
    });
    expect(await controller.resendCode('new')).toEqual(failure());
    fixture.setNow(1_060_000);
    expect(await controller.resendCode('new')).toEqual(success(undefined));
    expect(auth.resendEmailChangeCode).toHaveBeenCalledWith({
      email: 'new@example.com',
      address: 'new',
    });
    expect(await controller.verifyEmailChangeCode('new', '9876543210')).toEqual(success(undefined));
    expect(auth.verifyEmailChangeCode).toHaveBeenNthCalledWith(1, {
      email: 'person@example.com',
      code: '0123456789',
    });
    expect(auth.verifyEmailChangeCode).toHaveBeenNthCalledWith(2, {
      email: 'new@example.com',
      code: '9876543210',
    });
    expect(controller.getSnapshot()).toMatchObject({
      flow: { kind: 'idle' },
      me: { email: 'new@example.com' },
    });
  });

  it('rejects a step-up result for another user without changing the active session', async () => {
    const fixture = createFixture({ session: userSession, method: 'email_otp' });
    const { controller, auth, getSession } = fixture;
    auth.verifyStepUpCode.mockResolvedValue(success({ sameUser: false }));

    expect(await controller.beginStepUp('email_otp', 'person@example.com')).toEqual(
      success(undefined),
    );
    expect(await controller.verifyStepUpCode('0123456789')).toEqual(failure());
    expect(auth.verifyStepUpCode).toHaveBeenCalledWith({
      email: 'person@example.com',
      code: '0123456789',
      expectedUserId: userSession.userId,
    });
    expect(getSession()).toEqual(userSession);
    expect(controller.getSnapshot()).toMatchObject({
      session: userSession,
      authMethod: 'email_otp',
      flow: { kind: 'idle' },
      error: 'auth.failed',
    });
  });

  it('requires the active password method for same-user password step-up', async () => {
    const fixture = createFixture({ session: userSession, method: 'email_password' });
    const { controller, auth, getSession } = fixture;
    auth.stepUpWithPassword
      .mockResolvedValueOnce(success({ sameUser: false }))
      .mockResolvedValueOnce(success({ sameUser: true }));

    expect(await controller.beginStepUp('email_otp', 'person@example.com')).toEqual(failure());
    expect(
      await controller.beginStepUp('email_password', 'person@example.com', 'Password123'),
    ).toEqual(failure());
    expect(
      await controller.beginStepUp('email_password', 'person@example.com', 'Password123'),
    ).toEqual(success(undefined));
    expect(auth.stepUpWithPassword).toHaveBeenNthCalledWith(1, {
      email: 'person@example.com',
      password: 'Password123',
      expectedUserId: userSession.userId,
    });
    expect(getSession()).toEqual(userSession);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('Password123');
  });

  it('invalidates late authentication responses after logout', async () => {
    const fixture = createFixture();
    const { controller, auth, getSession } = fixture;
    let resolveSignIn: ((result: AuthResult<void>) => void) | undefined;
    auth.signInWithPassword.mockImplementation(
      () =>
        new Promise<AuthResult<void>>((resolve) => {
          resolveSignIn = resolve;
        }),
    );

    const pendingLogin = controller.signInWithPassword('person@example.com', 'Password123');
    expect(controller.getSnapshot().isBusy).toBe(true);
    expect(await controller.signOut('local')).toEqual(success(undefined));
    resolveSignIn?.(success(undefined));

    expect(await pendingLogin).toEqual(failure());
    expect(getSession()).toBeNull();
    expect(controller.getSnapshot()).toMatchObject({
      accessStatus: 'signed_out',
      flow: { kind: 'idle' },
    });
  });

  it('requires recent authentication for global sign-out but keeps local sign-out available', async () => {
    const fixture = createFixture({
      session: userSession,
      method: 'email_password',
      recent: false,
    });

    expect(await fixture.controller.signOut('global')).toEqual(failure());
    expect(fixture.auth.signOut).not.toHaveBeenCalled();
    expect(fixture.getSession()).toEqual(userSession);

    expect(await fixture.controller.signOut('local')).toEqual(success(undefined));
    expect(fixture.auth.signOut).toHaveBeenCalledWith('local');
    expect(fixture.getSession()).toBeNull();
  });

  it('tracks session changes delivered by the preserved extension auth facade', () => {
    const fixture = createFixture();

    fixture.setSession(userSession);

    expect(fixture.controller.getSnapshot()).toMatchObject({
      accessStatus: 'signed_in',
      session: userSession,
    });
  });

  it('discards a profile response from the previous account when an extension switches sessions', async () => {
    const fixture = createFixture({ session: userSession, method: 'email_password' });
    const otherSession: SessionSummary = {
      userId: '223e4567-e89b-42d3-a456-426614174001',
      isAnonymous: false,
    };
    const otherMe: MeResponse = {
      ...initialMe,
      id: otherSession.userId,
      email: 'other@example.com',
      displayName: 'Other',
    };
    let resolveStaleMe: ((result: AuthResult<MeResponse>) => void) | undefined;
    fixture.account.getMe
      .mockImplementationOnce(
        () =>
          new Promise<AuthResult<MeResponse>>((resolve) => {
            resolveStaleMe = resolve;
          }),
      )
      .mockResolvedValueOnce(success(otherMe));

    const staleRefresh = fixture.controller.refreshMe();
    expect(fixture.controller.getSnapshot().isBusy).toBe(true);

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await Promise.resolve();
    expect(fixture.account.getMe).toHaveBeenCalledTimes(1);

    fixture.setSession(otherSession);
    expect(fixture.controller.getSnapshot()).toMatchObject({
      session: otherSession,
      me: null,
      isBusy: false,
    });

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await Promise.resolve();
    resolveStaleMe?.(success(initialMe));

    await expect(staleRefresh).resolves.toEqual(failure());
    await Promise.resolve();
    expect(fixture.controller.getSnapshot()).toMatchObject({
      session: otherSession,
      me: otherMe,
      accessStatus: 'signed_in',
    });
    expect(fixture.controller.getSnapshot().me?.email).not.toBe(initialMe.email);
  });

  it('updates profile and auth email locale together, and updates consent state after acceptance', async () => {
    const fixture = createFixture({ session: userSession, method: 'email_password' });
    const { controller, account, auth } = fixture;

    expect(await controller.updateLocale('es')).toEqual(success({ ...initialMe, locale: 'es' }));
    expect(account.updateMe).toHaveBeenCalledWith({ locale: 'es' });
    expect(auth.updateLocale).toHaveBeenCalledWith('es');
    expect(controller.getSnapshot().me?.locale).toBe('es');
    expect(controller.getSnapshot().needsConsent).toEqual(['terms', 'privacy']);

    expect(await controller.acceptConsent({ document: 'terms', version: '2026-11-24' })).toEqual(
      success(undefined),
    );
    expect(controller.getSnapshot().needsConsent).toEqual(['privacy']);
  });
});
