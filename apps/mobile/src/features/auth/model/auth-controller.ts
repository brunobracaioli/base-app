import { z } from 'zod';

import { Locale as ContractLocale, type MeResponse } from '@base-app/contracts';
import type { AuthErrorKey, Locale, SessionSummary } from '../../../extensions/types';
import {
  type AuthController,
  type AuthControllerDependencies,
  type AuthFlowSnapshot,
  type AuthResult,
  type EmailChangeAddress,
  type FieldValidation,
  type AuthFieldError,
  type PasswordSetupPurpose,
  type SignOutScope,
  type StepUpMethod,
} from './auth-contracts';

const emailSchema = z.email();
const otpPattern = /^\d{10}$/;
const utf8ByteLength = (value: string): number => {
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x7f) length += 1;
    else if (codePoint <= 0x7ff) length += 2;
    else if (codePoint <= 0xffff) length += 3;
    else length += 4;
  }
  return length;
};

export function normalizeEmail(value: string): FieldValidation<string> {
  const email = value.trim().toLowerCase();
  if (!emailSchema.safeParse(email).success) {
    return { ok: false, error: 'invalid_email' };
  }
  return { ok: true, value: email };
}

export function validateOtpCode(value: string): FieldValidation<string> {
  const code = value.trim();
  return otpPattern.test(code) ? { ok: true, value: code } : { ok: false, error: 'invalid_code' };
}

export function validatePassword(value: string): FieldValidation<string> {
  if (Array.from(value).length < 10) {
    return { ok: false, error: 'password_too_short' };
  }
  if (utf8ByteLength(value) > 72) {
    return { ok: false, error: 'password_too_long' };
  }
  if (!/\p{L}/u.test(value)) {
    return { ok: false, error: 'password_requires_letter' };
  }
  if (!/\p{N}/u.test(value)) {
    return { ok: false, error: 'password_requires_digit' };
  }
  return { ok: true, value };
}

type OperationCheck = () => boolean;
type OperationSuccess<T> = (
  value: T,
  isCurrent: OperationCheck,
) => void | AuthErrorKey | Promise<void | AuthErrorKey>;

const genericFailure: AuthResult<never> = { ok: false, error: 'auth.failed' };
const cooldownMs = 60_000;

function mapFieldFailure(error: AuthFieldError): AuthErrorKey {
  void error;
  return 'auth.failed';
}

export function createAuthController(dependencies: AuthControllerDependencies): AuthController {
  const pendingPasswordSetup = dependencies.auth.getPendingPasswordSetup();
  let flow: AuthFlowSnapshot =
    pendingPasswordSetup === null
      ? { kind: 'idle' }
      : {
          kind: 'password_setup',
          purpose: pendingPasswordSetup,
          stage: 'new_password',
          email: null,
        };
  let me: ReturnType<AuthController['getSnapshot']>['me'] = null;
  let error: AuthErrorKey | null = null;
  let isBusy = false;
  let operationSequence = 0;
  let generation = 0;
  let authMethod: StepUpMethod | null = dependencies.auth.getCurrentAuthMethod();
  let expectedStepUpUserId: string | null = null;
  let stagedPasswordChangeNonce: string | null = null;
  let passwordChangeResendAvailableAt: number | null = null;
  let lastSessionUserId = dependencies.session.getSessionSummary()?.userId ?? null;
  let expectedSessionMutationDepth = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  let snapshotCache: ReturnType<AuthController['getSnapshot']> | null = null;

  const getSafeSessionSummary = (): SessionSummary | null => {
    return dependencies.session.getSessionSummary();
  };

  const remainingFor = (candidate: AuthFlowSnapshot): number => {
    const availableAt =
      candidate.kind === 'email_code' || candidate.kind === 'email_change'
        ? candidate.resendAvailableAt
        : candidate.kind === 'password_change' || candidate.kind === 'step_up'
          ? candidate.resendAvailableAt
          : null;
    return availableAt === null
      ? 0
      : Math.max(0, Math.ceil((availableAt - dependencies.now()) / 1000));
  };

  const buildSnapshot = (): ReturnType<AuthController['getSnapshot']> => {
    const session = getSafeSessionSummary();
    const accessStatus =
      flow.kind === 'password_setup'
        ? 'password_setup_required'
        : session === null
          ? 'signed_out'
          : 'signed_in';
    return {
      accessStatus,
      session,
      authMethod: authMethod ?? dependencies.auth.getCurrentAuthMethod(),
      flow,
      isBusy,
      error,
      me,
      needsConsent: me?.consents.needsAcceptance ?? [],
      resendSecondsRemaining: remainingFor(flow),
    };
  };

  const publish = (): void => {
    snapshotCache = buildSnapshot();
    for (const listener of listeners) listener();
  };

  const withExpectedSessionMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    expectedSessionMutationDepth += 1;
    try {
      return await operation();
    } finally {
      expectedSessionMutationDepth -= 1;
    }
  };

  const sessionUnsubscribe = dependencies.session.subscribe(() => {
    if (disposed) return;
    const nextUserId = dependencies.session.getSessionSummary()?.userId ?? null;
    const pendingSetup = dependencies.auth.getPendingPasswordSetup();
    const pendingSetupWasCleared = flow.kind === 'password_setup' && pendingSetup === null;
    const sessionIdentityChanged = nextUserId !== lastSessionUserId;
    if (expectedSessionMutationDepth === 0 && (sessionIdentityChanged || pendingSetupWasCleared)) {
      lastSessionUserId = nextUserId;
      generation += 1;
      operationSequence += 1;
      isBusy = false;
      me = null;
      authMethod = dependencies.auth.getCurrentAuthMethod();
      expectedStepUpUserId = null;
      stagedPasswordChangeNonce = null;
      passwordChangeResendAvailableAt = null;
      flow =
        pendingSetup === null
          ? { kind: 'idle' }
          : { kind: 'password_setup', purpose: pendingSetup, stage: 'new_password', email: null };

      if (nextUserId !== null && pendingSetup === null) {
        const observedGeneration = generation;
        queueMicrotask(() => {
          if (
            !disposed &&
            generation === observedGeneration &&
            !isBusy &&
            dependencies.session.getSessionSummary()?.userId === nextUserId
          ) {
            void refreshMe();
          }
        });
      }
    }
    lastSessionUserId = nextUserId;
    publish();
  });

  const getSnapshot = (): ReturnType<AuthController['getSnapshot']> => {
    if (snapshotCache === null) snapshotCache = buildSnapshot();
    return snapshotCache;
  };

  const perform = async <T>(
    call: (isCurrent: OperationCheck) => Promise<AuthResult<T>>,
    onSuccess?: OperationSuccess<T>,
  ): Promise<AuthResult<T>> => {
    const sequence = ++operationSequence;
    const currentGeneration = generation;
    const isCurrent = (): boolean =>
      !disposed && sequence === operationSequence && currentGeneration === generation;
    isBusy = true;
    error = null;
    publish();

    let result: AuthResult<T>;
    try {
      result = await call(isCurrent);
    } catch {
      result = { ok: false, error: 'auth.failed' };
    }

    if (!isCurrent()) return genericFailure;
    if (!result.ok) {
      error = result.error;
    } else if (onSuccess !== undefined) {
      try {
        const followUpError = await onSuccess(result.value, isCurrent);
        if (!isCurrent()) return genericFailure;
        if (followUpError !== undefined) {
          result = { ok: false, error: followUpError };
          error = followUpError;
        }
      } catch {
        result = { ok: false, error: 'auth.failed' };
        error = 'auth.failed';
      }
    }

    if (isCurrent()) {
      isBusy = false;
      publish();
    }
    return result;
  };

  const failField = (fieldError: AuthFieldError): AuthResult<void> => {
    error = mapFieldFailure(fieldError);
    publish();
    return { ok: false, error };
  };

  const readMe = async (isCurrent: OperationCheck): Promise<void> => {
    const result = await dependencies.account.getMe();
    if (!isCurrent()) return;
    if (result.ok) {
      me = result.value;
      if (flow.kind === 'password_setup' && flow.email === null) {
        flow = { ...flow, email: result.value.email };
      }
    }
  };

  const completeSignIn = async (
    isCurrent: OperationCheck,
    method: StepUpMethod,
  ): Promise<AuthErrorKey | void> => {
    const session = getSafeSessionSummary();
    if (session === null) return 'auth.session_missing';
    if (flow.kind !== 'password_setup') flow = { kind: 'idle' };
    authMethod = method;
    expectedStepUpUserId = null;
    try {
      await dependencies.lifecycle?.onSignedIn(session.userId);
    } catch {
      // Lifecycle hooks are best-effort and must not block authentication.
    }
    await readMe(isCurrent);
  };

  const setCodeCooldown = (candidate: AuthFlowSnapshot): AuthFlowSnapshot => {
    const resendAvailableAt = dependencies.now() + cooldownMs;
    if (candidate.kind === 'email_code' || candidate.kind === 'email_change') {
      return { ...candidate, resendAvailableAt };
    }
    if (candidate.kind === 'password_change' || candidate.kind === 'step_up') {
      return { ...candidate, resendAvailableAt };
    }
    return candidate;
  };

  const startEmailCode = async (
    emailInput: string,
    purpose: 'sign_in' | 'sign_up',
  ): Promise<AuthResult<void>> => {
    const email = normalizeEmail(emailInput);
    if (!email.ok) return failField(email.error);
    const nextFlow: AuthFlowSnapshot = {
      kind: 'email_code',
      purpose,
      stage: 'code',
      email: email.value,
      resendAvailableAt: dependencies.now() + cooldownMs,
    };
    return perform(
      () =>
        dependencies.auth.sendEmailCode({
          email: email.value,
          locale: dependencies.locale(),
          purpose,
        }),
      () => {
        flow = nextFlow;
      },
    );
  };

  const beginSignInWithCode = (email: string): Promise<AuthResult<void>> =>
    startEmailCode(email, 'sign_in');

  const beginSignUp = (email: string): Promise<AuthResult<void>> =>
    startEmailCode(email, 'sign_up');

  const signInWithPassword = async (
    emailInput: string,
    password: string,
  ): Promise<AuthResult<void>> => {
    const email = normalizeEmail(emailInput);
    if (!email.ok) return failField(email.error);
    const checkedPassword = validatePassword(password);
    if (!checkedPassword.ok) return failField(checkedPassword.error);
    flow = { kind: 'password_sign_in', stage: 'credentials', email: email.value };
    return perform(
      () =>
        withExpectedSessionMutation(() =>
          dependencies.auth.signInWithPassword({ email: email.value, password }),
        ),
      async (_value, isCurrent) => {
        const followUpError = await completeSignIn(isCurrent, 'email_password');
        return followUpError;
      },
    );
  };

  const beginPasswordRecovery = async (emailInput: string): Promise<AuthResult<void>> => {
    const email = normalizeEmail(emailInput);
    if (!email.ok) return failField(email.error);
    const nextFlow: AuthFlowSnapshot = {
      kind: 'email_code',
      purpose: 'recovery',
      stage: 'code',
      email: email.value,
      resendAvailableAt: dependencies.now() + cooldownMs,
    };
    return perform(
      () =>
        dependencies.auth.sendPasswordResetCode({
          email: email.value,
          locale: dependencies.locale(),
        }),
      () => {
        flow = nextFlow;
      },
    );
  };

  const resendCode = async (emailChangeAddress?: EmailChangeAddress): Promise<AuthResult<void>> => {
    if (remainingFor(flow) > 0) return failField('invalid_code');
    if (flow.kind === 'email_code') {
      const currentFlow = flow;
      const purpose = currentFlow.purpose;
      if (purpose === 'recovery') {
        return perform(
          () =>
            dependencies.auth.sendPasswordResetCode({
              email: currentFlow.email,
              locale: dependencies.locale(),
              resend: true,
            }),
          () => {
            if (flow === currentFlow) flow = setCodeCooldown(currentFlow);
          },
        );
      }
      return perform(
        () =>
          dependencies.auth.sendEmailCode({
            email: currentFlow.email,
            locale: dependencies.locale(),
            purpose,
            resend: true,
          }),
        () => {
          if (flow === currentFlow) flow = setCodeCooldown(currentFlow);
        },
      );
    }
    if (flow.kind === 'password_change' && flow.stage === 'code') {
      const email = me?.email;
      if (email === null || email === undefined) return failField('invalid_email');
      const currentFlow = flow;
      return perform(
        () =>
          dependencies.auth.sendPasswordChangeCode({
            email,
            locale: dependencies.locale(),
            resend: true,
          }),
        () => {
          if (flow === currentFlow) flow = setCodeCooldown(currentFlow);
        },
      );
    }
    if (flow.kind === 'step_up' && flow.method === 'email_otp' && flow.stage === 'code') {
      const currentFlow = flow;
      return perform(
        () =>
          dependencies.auth.sendEmailCode({
            email: currentFlow.email,
            locale: dependencies.locale(),
            purpose: 'step_up',
            resend: true,
          }),
        () => {
          if (flow === currentFlow) flow = setCodeCooldown(currentFlow);
        },
      );
    }
    if (flow.kind === 'email_change' && emailChangeAddress !== undefined) {
      const currentFlow = flow;
      const alreadyVerified =
        emailChangeAddress === 'old'
          ? currentFlow.oldAddressVerified
          : currentFlow.newAddressVerified;
      if (alreadyVerified) return failField('invalid_code');
      const email = emailChangeAddress === 'old' ? currentFlow.oldEmail : currentFlow.newEmail;
      return perform(
        () => dependencies.auth.resendEmailChangeCode({ email, address: emailChangeAddress }),
        () => {
          if (flow === currentFlow) flow = setCodeCooldown(currentFlow);
        },
      );
    }
    return failField('invalid_code');
  };

  const verifyCode = async (rawCode: string): Promise<AuthResult<void>> => {
    if (flow.kind !== 'email_code') return failField('invalid_code');
    const code = validateOtpCode(rawCode);
    if (!code.ok) return failField(code.error);
    const currentFlow = flow;
    return perform(
      () => {
        const verify = () =>
          dependencies.auth.verifyEmailCode({
            email: currentFlow.email,
            code: code.value,
            purpose: currentFlow.purpose === 'recovery' ? 'recovery' : currentFlow.purpose,
          });
        return currentFlow.purpose === 'sign_in' ? withExpectedSessionMutation(verify) : verify();
      },
      async (_value, isCurrent) => {
        if (!isCurrent()) return 'auth.failed';
        if (currentFlow.purpose === 'sign_up') {
          flow = {
            kind: 'password_setup',
            purpose: 'sign_up',
            stage: 'new_password',
            email: currentFlow.email,
          };
          return;
        }
        if (currentFlow.purpose === 'recovery') {
          flow = {
            kind: 'password_setup',
            purpose: 'recovery',
            stage: 'new_password',
            email: currentFlow.email,
          };
          return;
        }
        return completeSignIn(isCurrent, 'email_otp');
      },
    );
  };

  const setPassword = async (password: string): Promise<AuthResult<void>> => {
    if (flow.kind !== 'password_setup') return failField('password_too_short');
    const checkedPassword = validatePassword(password);
    if (!checkedPassword.ok) return failField(checkedPassword.error);
    const currentFlow = flow;
    const purpose: PasswordSetupPurpose = currentFlow.purpose;
    return perform(
      () =>
        withExpectedSessionMutation(() =>
          dependencies.auth.updatePassword({
            password: checkedPassword.value,
            purpose: purpose === 'sign_up' ? 'setup' : 'recovery',
          }),
        ),
      async (_value, isCurrent) => {
        const followUpError = await completeSignIn(isCurrent, 'email_password');
        if (followUpError === undefined && isCurrent()) flow = { kind: 'idle' };
        return followUpError;
      },
    );
  };

  const beginPasswordChange = async (): Promise<AuthResult<void>> => {
    const session = getSafeSessionSummary();
    if (session === null || session.isAnonymous) return genericFailure;
    if (!dependencies.auth.isRecentlyAuthenticated(dependencies.recentAuthMaxAgeSec())) {
      return genericFailure;
    }
    let email = me?.email ?? null;
    if (email === null) {
      const profile = await perform(
        () => dependencies.account.getMe(),
        (value) => {
          me = value;
        },
      );
      if (!profile.ok) return { ok: false, error: profile.error };
      email = profile.value.email;
    }
    if (email === null) return failField('invalid_email');
    stagedPasswordChangeNonce = null;
    const nextFlow: AuthFlowSnapshot = {
      kind: 'password_change',
      stage: 'code',
      resendAvailableAt: dependencies.now() + cooldownMs,
    };
    passwordChangeResendAvailableAt = nextFlow.resendAvailableAt;
    return perform(
      () => dependencies.auth.sendPasswordChangeCode({ email, locale: dependencies.locale() }),
      () => {
        flow = nextFlow;
      },
    );
  };

  const stagePasswordChangeCode = async (rawCode: string): Promise<AuthResult<void>> => {
    if (flow.kind !== 'password_change' || flow.stage !== 'code') {
      return failField('invalid_code');
    }
    const checkedCode = validateOtpCode(rawCode);
    if (!checkedCode.ok) return failField(checkedCode.error);
    stagedPasswordChangeNonce = checkedCode.value;
    flow = { ...flow, stage: 'new_password', resendAvailableAt: null };
    error = null;
    publish();
    return { ok: true, value: undefined };
  };

  const changePassword = async (password: string): Promise<AuthResult<void>> => {
    if (flow.kind !== 'password_change' || flow.stage !== 'new_password') {
      return failField('password_too_short');
    }
    const checkedPassword = validatePassword(password);
    if (!checkedPassword.ok) return failField(checkedPassword.error);
    const result = await perform(
      () =>
        dependencies.auth.updatePassword({
          password: checkedPassword.value,
          purpose: 'change',
          ...(stagedPasswordChangeNonce === null ? {} : { nonce: stagedPasswordChangeNonce }),
        }),
      () => {
        flow = { kind: 'idle' };
        stagedPasswordChangeNonce = null;
        passwordChangeResendAvailableAt = null;
      },
    );
    if (!result.ok && flow.kind === 'password_change' && flow.stage === 'new_password') {
      stagedPasswordChangeNonce = null;
      flow = {
        kind: 'password_change',
        stage: 'code',
        resendAvailableAt: passwordChangeResendAvailableAt,
      };
      publish();
    }
    return result;
  };

  const beginEmailChange = async (emailInput: string): Promise<AuthResult<void>> => {
    const session = getSafeSessionSummary();
    if (session === null || session.isAnonymous) return genericFailure;
    if (!dependencies.auth.isRecentlyAuthenticated(dependencies.recentAuthMaxAgeSec())) {
      return genericFailure;
    }
    const newEmail = normalizeEmail(emailInput);
    if (!newEmail.ok) return failField(newEmail.error);
    let oldEmail = me?.email ?? null;
    if (oldEmail === null) {
      const profile = await perform(
        () => dependencies.account.getMe(),
        (value) => {
          me = value;
        },
      );
      if (!profile.ok) return { ok: false, error: profile.error };
      oldEmail = profile.value.email;
    }
    if (oldEmail === null) return failField('invalid_email');
    if (newEmail.value === oldEmail) return failField('invalid_email');
    const nextFlow: AuthFlowSnapshot = {
      kind: 'email_change',
      stage: 'verify_old',
      oldEmail,
      newEmail: newEmail.value,
      oldAddressVerified: false,
      newAddressVerified: false,
      resendAvailableAt: dependencies.now() + cooldownMs,
    };
    return perform(
      () => dependencies.auth.beginEmailChange({ email: newEmail.value }),
      () => {
        flow = nextFlow;
      },
    );
  };

  const verifyEmailChangeCode = async (
    address: EmailChangeAddress,
    rawCode: string,
  ): Promise<AuthResult<void>> => {
    if (flow.kind !== 'email_change') return failField('invalid_code');
    const checkedCode = validateOtpCode(rawCode);
    if (!checkedCode.ok) return failField(checkedCode.error);
    const currentFlow = flow;
    const email = address === 'old' ? currentFlow.oldEmail : currentFlow.newEmail;
    return perform(
      () => dependencies.auth.verifyEmailChangeCode({ email, code: checkedCode.value }),
      async (_value, isCurrent) => {
        if (!isCurrent() || flow.kind !== 'email_change') return 'auth.failed';
        const oldAddressVerified = flow.oldAddressVerified || address === 'old';
        const newAddressVerified = flow.newAddressVerified || address === 'new';
        if (oldAddressVerified && newAddressVerified) {
          flow = { kind: 'idle' };
          await readMe(isCurrent);
        } else {
          flow = {
            ...flow,
            oldAddressVerified,
            newAddressVerified,
            stage: oldAddressVerified ? 'verify_new' : 'verify_old',
          };
        }
      },
    );
  };

  const beginStepUp = async (
    method: StepUpMethod,
    emailInput: string,
    password?: string,
  ): Promise<AuthResult<void>> => {
    const session = getSafeSessionSummary();
    if (session === null || session.isAnonymous) return genericFailure;
    const activeMethod = authMethod ?? dependencies.auth.getCurrentAuthMethod();
    if (activeMethod === null || activeMethod !== method) return genericFailure;
    const email = normalizeEmail(emailInput);
    if (!email.ok) return failField(email.error);
    expectedStepUpUserId = session.userId;
    if (method === 'email_password') {
      if (password === undefined) return failField('password_too_short');
      const checkedPassword = validatePassword(password);
      if (!checkedPassword.ok) return failField(checkedPassword.error);
      const result = await perform(
        () =>
          dependencies.auth.stepUpWithPassword({
            email: email.value,
            password: checkedPassword.value,
            expectedUserId: session.userId,
          }),
        async (result) => {
          if (!result.sameUser) {
            expectedStepUpUserId = null;
            return 'auth.failed';
          }
          flow = { kind: 'idle' };
          authMethod = method;
          await dependencies.lifecycle?.onSignedIn(session.userId);
        },
      );
      return result.ok ? { ok: true, value: undefined } : result;
    }
    const nextFlow: AuthFlowSnapshot = {
      kind: 'step_up',
      method,
      stage: 'code',
      email: email.value,
      resendAvailableAt: dependencies.now() + cooldownMs,
    };
    const result = await perform(
      () =>
        dependencies.auth.sendEmailCode({
          email: email.value,
          locale: dependencies.locale(),
          purpose: 'step_up',
        }),
      () => {
        flow = nextFlow;
      },
    );
    return result.ok ? { ok: true, value: undefined } : result;
  };

  const verifyStepUpCode = async (rawCode: string): Promise<AuthResult<void>> => {
    if (flow.kind !== 'step_up' || flow.method !== 'email_otp' || flow.stage !== 'code') {
      return failField('invalid_code');
    }
    const checkedCode = validateOtpCode(rawCode);
    if (!checkedCode.ok) return failField(checkedCode.error);
    const expectedUserId = expectedStepUpUserId;
    if (expectedUserId === null) return genericFailure;
    const currentFlow = flow;
    const result = await perform(
      () =>
        dependencies.auth.verifyStepUpCode({
          email: currentFlow.email,
          code: checkedCode.value,
          expectedUserId,
        }),
      async (result) => {
        if (!result.sameUser) {
          expectedStepUpUserId = null;
          flow = { kind: 'idle' };
          return 'auth.failed';
        }
        expectedStepUpUserId = null;
        authMethod = 'email_otp';
        flow = { kind: 'idle' };
        try {
          await dependencies.lifecycle?.onSignedIn(expectedUserId);
        } catch {
          // Lifecycle hooks are best-effort and must not block step-up.
        }
      },
    );
    return result.ok ? { ok: true, value: undefined } : result;
  };

  const signOut = async (scope: SignOutScope): Promise<AuthResult<void>> => {
    if (
      scope === 'global' &&
      !dependencies.auth.isRecentlyAuthenticated(dependencies.recentAuthMaxAgeSec())
    ) {
      return genericFailure;
    }
    const previousUserId = getSafeSessionSummary()?.userId ?? null;
    generation += 1;
    operationSequence += 1;
    flow = { kind: 'idle' };
    me = null;
    authMethod = null;
    expectedStepUpUserId = null;
    isBusy = false;
    error = null;
    publish();
    return perform(
      () => withExpectedSessionMutation(() => dependencies.auth.signOut(scope)),
      async () => {
        try {
          await dependencies.lifecycle?.onSignedOut(previousUserId);
        } catch {
          // Lifecycle hooks are best-effort and must not block sign-out.
        }
      },
    );
  };

  const refreshMe = (): Promise<AuthResult<MeResponse>> => {
    if (getSafeSessionSummary() === null) {
      return Promise.resolve({ ok: false, error: 'auth.session_missing' });
    }
    return perform(
      async (isCurrent) => {
        const revalidated = await dependencies.session.revalidate?.();
        if (!isCurrent()) return genericFailure;
        if (revalidated !== undefined && !revalidated.ok) return revalidated;
        return dependencies.account.getMe();
      },
      (value) => {
        me = value;
        if (flow.kind === 'password_setup' && flow.email === null) {
          flow = { ...flow, email: value.email };
        }
      },
    );
  };

  const updateProfile = async (
    input: Parameters<AuthController['updateProfile']>[0],
  ): Promise<AuthResult<MeResponse>> => {
    if (getSafeSessionSummary() === null) return { ok: false, error: 'auth.session_missing' };
    return perform(
      () => dependencies.account.updateMe(input),
      async (value) => {
        me = value;
        if (input.locale !== undefined) {
          const locale = ContractLocale.safeParse(input.locale);
          if (!locale.success) return 'auth.failed';
          const localeResult = await dependencies.auth.updateLocale(locale.data as Locale);
          if (!localeResult.ok) return localeResult.error;
        }
      },
    );
  };

  const updateLocale = (locale: Parameters<AuthController['updateLocale']>[0]) =>
    updateProfile({ locale });

  const hasRecentAuthentication = (): boolean => {
    const session = getSafeSessionSummary();
    return (
      session !== null &&
      !session.isAnonymous &&
      dependencies.auth.isRecentlyAuthenticated(dependencies.recentAuthMaxAgeSec())
    );
  };

  const acceptConsent = async (
    input: Parameters<AuthController['acceptConsent']>[0],
  ): Promise<AuthResult<void>> => {
    if (getSafeSessionSummary() === null) {
      return { ok: false, error: 'auth.session_missing' };
    }
    return perform(
      () => dependencies.account.acceptConsent(input),
      () => {
        if (me === null) return;
        me = {
          ...me,
          consents: {
            needsAcceptance: me.consents.needsAcceptance.filter(
              (document) => document !== input.document,
            ),
          },
        };
      },
    );
  };

  const resetFlow = (): void => {
    if (flow.kind === 'password_setup') return;
    generation += 1;
    operationSequence += 1;
    flow = { kind: 'idle' };
    error = null;
    isBusy = false;
    expectedStepUpUserId = null;
    stagedPasswordChangeNonce = null;
    passwordChangeResendAvailableAt = null;
    publish();
  };

  return {
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    beginSignInWithCode,
    beginSignUp,
    signInWithPassword,
    beginPasswordRecovery,
    resendCode,
    verifyCode,
    setPassword,
    beginPasswordChange,
    hasRecentAuthentication,
    stagePasswordChangeCode,
    changePassword,
    beginEmailChange,
    verifyEmailChangeCode,
    beginStepUp,
    verifyStepUpCode,
    signOut,
    refreshMe,
    updateProfile,
    updateLocale,
    acceptConsent,
    tick: publish,
    resetFlow,
    dispose() {
      disposed = true;
      generation += 1;
      operationSequence += 1;
      isBusy = false;
      sessionUnsubscribe();
      listeners.clear();
    },
  };
}
