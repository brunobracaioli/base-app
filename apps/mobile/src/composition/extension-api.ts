import type { ApiClient } from '../shared/api-client/api-client';
import { withCaptcha } from '../features/auth/api/with-captcha';
import type {
  AuthOperationsPort,
  CapturedPreviousSessionPort,
  SessionPort,
} from '../features/auth/model/auth-ports';
import type {
  EmailChangeOtpInput,
  IdentityTokenInput,
  LinkIdentityInput,
  UnlinkIdentityInput,
} from '../features/auth/model/auth-ports';
import type { AuthErrorKey, CaptchaProvider, Result } from '../extensions/types';

export type ExtensionApiDependencies = {
  readonly auth: AuthOperationsPort;
  readonly session: SessionPort;
  readonly apiClient: ApiClient;
  readonly captchaProvider: CaptchaProvider | null;
};

export type ExtensionAuthApi = {
  signInAnonymously(): Promise<Result<void, AuthErrorKey>>;
  signInWithIdToken(input: IdentityTokenInput): Promise<Result<void, AuthErrorKey>>;
  linkIdentity(input: LinkIdentityInput): Promise<Result<void, AuthErrorKey>>;
  unlinkIdentity(input: UnlinkIdentityInput): Promise<Result<void, AuthErrorKey>>;
  updateEmail(email: string): Promise<Result<void, AuthErrorKey>>;
  verifyEmailChangeOtp(input: EmailChangeOtpInput): Promise<Result<void, AuthErrorKey>>;
  refreshSession(): Promise<Result<void, AuthErrorKey>>;
  signOutEverywhere(): Promise<Result<void, AuthErrorKey>>;
  withPreviousSession<T>(fn: (previousAccessToken: string) => Promise<T>): Promise<T>;
};

export type ExtensionApiRuntime = {
  readonly extensionAuth: ExtensionAuthApi;
  readonly extensionApiClient: ApiClient;
  readonly sessionPort: SessionPort;
  readonly captchaProvider: CaptchaProvider | null;
};

export const unavailableExtensionApiClient: ApiClient = {
  request<T>(): Promise<T> {
    return Promise.reject(new Error('Extension API client is unavailable.'));
  },
};

const safePreviousSessionErrorMessage = 'Extension callback failed.';

function invalidPreviousSessionResult(): never {
  throw new Error('The extension callback returned an unsupported result.');
}

function assertNoPreviousToken(value: string, previousAccessToken: string | null): void {
  if (
    previousAccessToken !== null &&
    previousAccessToken.length > 0 &&
    value.includes(previousAccessToken)
  ) {
    invalidPreviousSessionResult();
  }
}

function hasOwnValue(
  descriptor: PropertyDescriptor,
): descriptor is PropertyDescriptor & { value: unknown } {
  return Object.prototype.hasOwnProperty.call(descriptor, 'value');
}

function copySafePreviousSessionResult(
  value: unknown,
  previousAccessToken: string | null,
): unknown {
  const ancestors = new WeakSet<object>();

  function copy(candidate: unknown): unknown {
    if (candidate === null || candidate === undefined || typeof candidate === 'boolean') {
      return candidate;
    }
    if (typeof candidate === 'string') {
      assertNoPreviousToken(candidate, previousAccessToken);
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        return invalidPreviousSessionResult();
      }
      return candidate;
    }
    if (typeof candidate !== 'object') {
      return invalidPreviousSessionResult();
    }
    if (ancestors.has(candidate)) {
      return invalidPreviousSessionResult();
    }

    ancestors.add(candidate);
    try {
      const prototype = Object.getPrototypeOf(candidate);
      const ownKeys = Reflect.ownKeys(candidate);
      const isArray = Array.isArray(candidate);

      if (isArray) {
        if (prototype !== Array.prototype) {
          return invalidPreviousSessionResult();
        }

        const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, 'length');
        if (
          lengthDescriptor === undefined ||
          !hasOwnValue(lengthDescriptor) ||
          typeof lengthDescriptor.value !== 'number' ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0
        ) {
          return invalidPreviousSessionResult();
        }

        const length = lengthDescriptor.value;
        const indexDescriptors: Array<{ key: string; descriptor: PropertyDescriptor }> = [];
        for (const key of ownKeys) {
          if (typeof key !== 'string') {
            return invalidPreviousSessionResult();
          }
          assertNoPreviousToken(key, previousAccessToken);
          if (key === 'length') {
            continue;
          }

          const index = Number(key);
          if (
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= length ||
            String(index) !== key
          ) {
            return invalidPreviousSessionResult();
          }

          const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
          if (descriptor === undefined || !hasOwnValue(descriptor)) {
            return invalidPreviousSessionResult();
          }
          indexDescriptors.push({ key, descriptor });
        }

        const copied = new Array(length);
        for (const { key, descriptor } of indexDescriptors) {
          Object.defineProperty(copied, key, {
            value: copy(descriptor.value),
            enumerable: descriptor.enumerable === true,
            writable: false,
            configurable: false,
          });
        }
        return Object.freeze(copied);
      }

      if (prototype !== Object.prototype && prototype !== null) {
        return invalidPreviousSessionResult();
      }

      const copied: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of ownKeys) {
        if (typeof key !== 'string') {
          return invalidPreviousSessionResult();
        }
        assertNoPreviousToken(key, previousAccessToken);
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !hasOwnValue(descriptor)) {
          return invalidPreviousSessionResult();
        }
        Object.defineProperty(copied, key, {
          value: copy(descriptor.value),
          enumerable: descriptor.enumerable === true,
          writable: false,
          configurable: false,
        });
      }
      return Object.freeze(copied);
    } finally {
      ancestors.delete(candidate);
    }
  }

  return copy(value);
}

async function withPreviousSession<T>(
  session: SessionPort,
  fn: (previousAccessToken: string) => Promise<T>,
): Promise<T> {
  let capturedSession: CapturedPreviousSessionPort | null;
  try {
    capturedSession = await session.capturePreviousSession();
  } catch {
    throw new Error(safePreviousSessionErrorMessage);
  }

  if (capturedSession === null) {
    throw new Error(safePreviousSessionErrorMessage);
  }

  let result: T | undefined;
  let failed = false;
  try {
    const previousAccessToken = await capturedSession.getAccessToken();
    if (previousAccessToken === null || previousAccessToken.length === 0) {
      invalidPreviousSessionResult();
    }
    result = copySafePreviousSessionResult(await fn(previousAccessToken), previousAccessToken) as T;
  } catch {
    failed = true;
  } finally {
    try {
      await capturedSession.signOutLocal();
    } catch {
      failed = true;
    }
  }

  if (failed) {
    throw new Error(safePreviousSessionErrorMessage);
  }
  return result as T;
}

export function createExtensionApi(dependencies: ExtensionApiDependencies): ExtensionApiRuntime {
  const { auth, session, apiClient, captchaProvider } = dependencies;

  return {
    extensionAuth: {
      signInAnonymously: () =>
        withCaptcha(captchaProvider, 'anonymous', (token) => auth.signInAnonymously(token)),
      signInWithIdToken: (input) =>
        withCaptcha(captchaProvider, 'social', (token) => auth.signInWithIdToken(input, token)),
      linkIdentity: (input) => auth.linkIdentity(input, undefined),
      unlinkIdentity: (input) => auth.unlinkIdentity(input),
      updateEmail: (email) => auth.updateEmail(email),
      verifyEmailChangeOtp: (input) => auth.verifyEmailChangeOtp(input),
      refreshSession: () => auth.refreshSession(),
      signOutEverywhere: () => auth.signOutEverywhere(),
      withPreviousSession: (fn) => withPreviousSession(session, fn),
    },
    extensionApiClient: apiClient,
    sessionPort: session,
    captchaProvider,
  };
}

type RuntimeRegistration = {
  readonly id: symbol;
  readonly runtime: ExtensionApiRuntime;
};

const runtimeRegistrations: RuntimeRegistration[] = [];
const runtimeListeners = new Set<() => void>();
const pendingCaptchaDisposals = new WeakSet<CaptchaProvider>();
const disposedCaptchaProviders = new WeakSet<CaptchaProvider>();

function notifyRuntimeListeners(): void {
  for (const listener of runtimeListeners) {
    try {
      listener();
    } catch {
      // Runtime listeners must not make facade installation fail.
    }
  }
}

function scheduleCaptchaProviderDisposal(captchaProvider: CaptchaProvider): void {
  if (
    pendingCaptchaDisposals.has(captchaProvider) ||
    disposedCaptchaProviders.has(captchaProvider)
  ) {
    return;
  }

  pendingCaptchaDisposals.add(captchaProvider);
  queueMicrotask(() => {
    pendingCaptchaDisposals.delete(captchaProvider);
    const stillRegistered = runtimeRegistrations.some(
      (candidate) => candidate.runtime.captchaProvider === captchaProvider,
    );
    if (stillRegistered || disposedCaptchaProviders.has(captchaProvider)) {
      return;
    }

    disposedCaptchaProviders.add(captchaProvider);
    try {
      captchaProvider.dispose();
    } catch {
      // Provider disposal must not break shell teardown.
    }
  });
}

export function installExtensionApi(dependencies: ExtensionApiDependencies): () => void {
  const runtime = createExtensionApi(dependencies);
  const registration: RuntimeRegistration = { id: Symbol('mobile-extension-api'), runtime };
  runtimeRegistrations.push(registration);
  notifyRuntimeListeners();

  return () => {
    const registrationIndex = runtimeRegistrations.findIndex(
      (candidate) => candidate.id === registration.id,
    );
    if (registrationIndex !== -1) {
      runtimeRegistrations.splice(registrationIndex, 1);
      notifyRuntimeListeners();
      const captchaProvider = registration.runtime.captchaProvider;
      if (captchaProvider !== null) {
        scheduleCaptchaProviderDisposal(captchaProvider);
      }
    }
  };
}

export function getConfiguredExtensionApi(): ExtensionApiRuntime | null {
  return runtimeRegistrations[runtimeRegistrations.length - 1]?.runtime ?? null;
}

export function subscribeExtensionApiRuntime(listener: () => void): () => void {
  runtimeListeners.add(listener);
  return () => runtimeListeners.delete(listener);
}
