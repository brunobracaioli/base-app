import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import type { ApiClient } from '../shared/api-client/api-client';
import { AppProviders } from '../features/shell/ui/app-providers';
import { extensionApiClient, extensionAuth, useSessionSummary } from './api';
import { createExtensionApi, installExtensionApi } from '../composition/extension-api';
import type {
  AuthOperationsPort,
  CapturedPreviousSessionPort,
  SessionPort,
} from '../features/auth/model/auth-ports';
import { CaptchaError, type CaptchaProvider, type SessionSummary } from './types';

function createPorts(summary: SessionSummary | null = null) {
  const auth: jest.Mocked<AuthOperationsPort> = {
    signInAnonymously: jest.fn().mockResolvedValue({ ok: true, value: undefined }),
    signInWithIdToken: jest.fn().mockResolvedValue({ ok: true, value: undefined }),
    linkIdentity: jest.fn().mockResolvedValue({ ok: true, value: undefined }),
    unlinkIdentity: jest.fn().mockResolvedValue({ ok: true, value: undefined }),
    updateEmail: jest.fn().mockResolvedValue({ ok: true, value: undefined }),
    verifyEmailChangeOtp: jest.fn().mockResolvedValue({ ok: true, value: undefined }),
    refreshSession: jest.fn().mockResolvedValue({ ok: true, value: undefined }),
    signOutEverywhere: jest.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
  let currentAccessToken: string | null = 'primary-session-token';
  let currentSummary = summary;
  const listeners = new Set<() => void>();
  const capturedSession: jest.Mocked<CapturedPreviousSessionPort> = {
    getAccessToken: jest.fn().mockResolvedValue('previous-session-secret'),
    signOutLocal: jest.fn().mockResolvedValue(undefined),
  };
  const getCurrentAccessToken = jest.fn(async () => currentAccessToken);
  const capturePreviousSession = jest.fn(
    async (): Promise<CapturedPreviousSessionPort | null> => capturedSession,
  );
  const session: SessionPort = {
    getCurrentAccessToken,
    getSessionSummary: () => currentSummary,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    signOutLocal: jest.fn(async () => {
      currentAccessToken = null;
    }),
    capturePreviousSession,
  };
  return {
    auth,
    session,
    capturedSession,
    capturePreviousSession,
    getCurrentAccessToken,
    setSummary(next: SessionSummary | null) {
      currentSummary = next;
      listeners.forEach((listener) => listener());
    },
    setCurrentAccessToken(next: string | null) {
      currentAccessToken = next;
    },
  };
}

const noCaptcha: CaptchaProvider | null = null;

describe('extension facade', () => {
  it('scopes the old access token to the callback, returns safe results, and signs out in finally', async () => {
    const ports = createPorts();
    const api = createExtensionApi({
      auth: ports.auth,
      session: ports.session,
      apiClient: {} as ApiClient,
      captchaProvider: noCaptcha,
    });
    const callback = jest.fn(async () => {
      ports.setCurrentAccessToken('new-primary-session-token');
      return { merged: true, count: 2 };
    });

    await expect(api.extensionAuth.withPreviousSession(callback)).resolves.toEqual({
      merged: true,
      count: 2,
    });
    expect(callback).toHaveBeenCalledWith('previous-session-secret');
    expect(ports.capturedSession.signOutLocal).toHaveBeenCalledTimes(1);
    await expect(ports.session.getCurrentAccessToken()).resolves.toBe('new-primary-session-token');
    expect(ports.session.signOutLocal).not.toHaveBeenCalled();

    const echoedTokenError = await api.extensionAuth
      .withPreviousSession(async (token) => ({ echoed: `value:${token}` }))
      .catch((error: unknown) => error);
    expect(echoedTokenError).toMatchObject({ message: 'Extension callback failed.' });
    expect(String(echoedTokenError)).not.toContain('previous-session-secret');
    expect(ports.capturedSession.signOutLocal).toHaveBeenCalledTimes(2);

    const failure = new Error('callback failure');
    const safeFailure = await api.extensionAuth
      .withPreviousSession(() => Promise.reject(failure))
      .catch((error: unknown) => error);
    expect(safeFailure).toMatchObject({ message: 'Extension callback failed.' });
    expect(safeFailure).not.toBe(failure);
    expect(ports.capturedSession.signOutLocal).toHaveBeenCalledTimes(3);

    const tokenBearingError = await api.extensionAuth
      .withPreviousSession(() => Promise.reject(new Error('failed previous-session-secret')))
      .catch((error: unknown) => error);
    expect(tokenBearingError).toMatchObject({ message: 'Extension callback failed.' });
    expect(tokenBearingError).not.toHaveProperty('cause');
    expect(String(tokenBearingError)).not.toContain('previous-session-secret');

    const tokenBearingObject = await api.extensionAuth
      .withPreviousSession(() =>
        Promise.reject({ cause: { accessToken: 'previous-session-secret' } }),
      )
      .catch((error: unknown) => error);
    expect(tokenBearingObject).toMatchObject({ message: 'Extension callback failed.' });
    expect(tokenBearingObject).not.toHaveProperty('cause');
    expect(JSON.stringify(tokenBearingObject)).not.toContain('previous-session-secret');
    expect(ports.capturedSession.signOutLocal).toHaveBeenCalledTimes(5);

    ports.capturedSession.signOutLocal.mockRejectedValueOnce(
      new Error('cleanup failed previous-session-secret'),
    );
    const cleanupFailure = await api.extensionAuth
      .withPreviousSession(async () => undefined)
      .catch((error: unknown) => error);
    expect(cleanupFailure).toMatchObject({ message: 'Extension callback failed.' });
    expect(JSON.stringify(cleanupFailure)).not.toContain('previous-session-secret');
    expect(ports.session.signOutLocal).not.toHaveBeenCalled();
    expect(JSON.stringify(api.extensionAuth)).not.toContain('previous-session-secret');
  });

  it('accepts simple values and returns frozen copies of arrays and plain records', async () => {
    const ports = createPorts();
    const api = createExtensionApi({
      auth: ports.auth,
      session: ports.session,
      apiClient: {} as ApiClient,
      captchaProvider: noCaptcha,
    });
    const child = { value: 'before' };
    const source = {
      token: 'ordinary metadata',
      accessToken: 'ordinary metadata',
      nested: child,
    };

    const copied = await api.extensionAuth.withPreviousSession(async () => source);
    expect(copied).not.toBe(source);
    expect(copied.nested).not.toBe(child);
    expect(Object.getPrototypeOf(copied)).toBeNull();
    expect(Object.isFrozen(copied)).toBe(true);
    expect(Object.isFrozen(copied.nested)).toBe(true);
    expect(copied).toMatchObject({ token: 'ordinary metadata', accessToken: 'ordinary metadata' });

    child.value = 'after';
    expect(copied.nested.value).toBe('before');

    const copiedArray = await api.extensionAuth.withPreviousSession(async () => [
      null,
      false,
      'safe',
      0,
      undefined,
    ]);
    expect(copiedArray).toEqual([null, false, 'safe', 0, undefined]);
    expect(Object.isFrozen(copiedArray)).toBe(true);
    await expect(
      api.extensionAuth.withPreviousSession(async () => undefined),
    ).resolves.toBeUndefined();
    expect(ports.capturedSession.signOutLocal).toHaveBeenCalledTimes(3);
  });

  it('rejects unsafe result graphs without invoking getters and sanitizes proxy traps', async () => {
    const ports = createPorts();
    const api = createExtensionApi({
      auth: ports.auth,
      session: ports.session,
      apiClient: {} as ApiClient,
      captchaProvider: noCaptcha,
    });
    const token = 'previous-session-secret';
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'safe';
      },
    });
    const cycle: { readonly self?: unknown } = {};
    Object.assign(cycle, { self: cycle });
    class OpaqueValue {
      readonly value = 'safe';
    }
    const proxy = new Proxy(
      { value: true },
      {
        ownKeys() {
          throw new Error(`trap ${token}`);
        },
      },
    );
    const candidates: readonly unknown[] = [
      () => undefined,
      Symbol('value'),
      1n,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
      new OpaqueValue(),
      new Date(0),
      new Map(),
      new Set(),
      accessor,
      cycle,
      token,
      { [token]: 'safe' },
      { [`prefix-${token}-suffix`]: 'safe' },
      { nested: `prefix-${token}-suffix` },
      proxy,
    ];

    for (const candidate of candidates) {
      const error = await api.extensionAuth
        .withPreviousSession(async () => candidate)
        .catch((cause: unknown) => cause);
      expect(error).toMatchObject({ message: 'Extension callback failed.' });
      expect(JSON.stringify(error)).not.toContain(token);
    }

    expect(getterCalls).toBe(0);
    expect(ports.capturedSession.signOutLocal).toHaveBeenCalledTimes(candidates.length);
  });

  it('rejects without invoking the callback or reading the primary session when there is no prior session', async () => {
    const ports = createPorts();
    ports.capturePreviousSession.mockResolvedValueOnce(null);
    const api = createExtensionApi({
      auth: ports.auth,
      session: ports.session,
      apiClient: {} as ApiClient,
      captchaProvider: noCaptcha,
    });
    const callback = jest.fn(async () => undefined);
    const error = await api.extensionAuth
      .withPreviousSession(callback)
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ message: 'Extension callback failed.' });
    expect(callback).not.toHaveBeenCalled();
    expect(ports.getCurrentAccessToken).not.toHaveBeenCalled();
    expect(ports.capturedSession.signOutLocal).not.toHaveBeenCalled();
  });

  it('sanitizes capture and token-read failures without falling back to the primary session', async () => {
    const ports = createPorts();
    const api = createExtensionApi({
      auth: ports.auth,
      session: ports.session,
      apiClient: {} as ApiClient,
      captchaProvider: noCaptcha,
    });

    ports.capturePreviousSession.mockRejectedValueOnce(
      new Error('capture failed previous-session-secret'),
    );
    const captureError = await api.extensionAuth
      .withPreviousSession(async () => 'safe')
      .catch((error: unknown) => error);
    expect(captureError).toMatchObject({ message: 'Extension callback failed.' });
    expect(ports.getCurrentAccessToken).not.toHaveBeenCalled();
    expect(ports.capturedSession.getAccessToken).not.toHaveBeenCalled();
    expect(ports.capturedSession.signOutLocal).not.toHaveBeenCalled();

    ports.capturedSession.getAccessToken.mockRejectedValueOnce(
      new Error('token read failed previous-session-secret'),
    );
    const callback = jest.fn(async () => 'safe');
    const tokenReadError = await api.extensionAuth
      .withPreviousSession(callback)
      .catch((error: unknown) => error);
    expect(tokenReadError).toMatchObject({ message: 'Extension callback failed.' });
    expect(callback).not.toHaveBeenCalled();
    expect(ports.capturedSession.signOutLocal).toHaveBeenCalledTimes(1);
    expect(ports.getCurrentAccessToken).not.toHaveBeenCalled();

    ports.capturedSession.getAccessToken.mockResolvedValueOnce(null);
    const missingTokenCallback = jest.fn(async () => 'safe');
    const missingTokenError = await api.extensionAuth
      .withPreviousSession(missingTokenCallback)
      .catch((error: unknown) => error);
    expect(missingTokenError).toMatchObject({ message: 'Extension callback failed.' });
    expect(missingTokenCallback).not.toHaveBeenCalled();
    expect(ports.capturedSession.signOutLocal).toHaveBeenCalledTimes(2);
    expect(ports.getCurrentAccessToken).not.toHaveBeenCalled();
    expect(await ports.session.getCurrentAccessToken()).toBe('primary-session-token');
  });

  it('preserves the auth facade contract inputs for linking, unlinking, and OTP verification', async () => {
    const ports = createPorts();
    const api = createExtensionApi({
      auth: ports.auth,
      session: ports.session,
      apiClient: {} as ApiClient,
      captchaProvider: noCaptcha,
    });

    await api.extensionAuth.linkIdentity({ provider: 'oidc' });
    expect(ports.auth.linkIdentity).toHaveBeenCalledWith({ provider: 'oidc' }, undefined);
    await api.extensionAuth.unlinkIdentity({ identityId: 'identity-1' });
    expect(ports.auth.unlinkIdentity).toHaveBeenCalledWith({ identityId: 'identity-1' });
    await api.extensionAuth.verifyEmailChangeOtp({
      email: 'user@example.test',
      token: 'otp-token',
    });
    expect(ports.auth.verifyEmailChangeOtp).toHaveBeenCalledWith({
      email: 'user@example.test',
      token: 'otp-token',
    });
  });

  it.each([
    ['signInAnonymously', 'anonymous'],
    ['signInWithIdToken', 'social'],
  ] as const)('%s obtains its CAPTCHA token through withCaptcha', async (methodName, action) => {
    const ports = createPorts();
    const provider: CaptchaProvider = {
      kind: 'test',
      prewarm: jest.fn(),
      getToken: jest.fn().mockResolvedValue({ token: 'captcha-secret', issuedAt: 1 }),
      release: jest.fn(),
      dispose: jest.fn(),
    };
    const api = createExtensionApi({
      auth: ports.auth,
      session: ports.session,
      apiClient: {} as ApiClient,
      captchaProvider: provider,
    });

    if (methodName === 'signInAnonymously') {
      await api.extensionAuth.signInAnonymously();
      expect(ports.auth.signInAnonymously).toHaveBeenCalledWith('captcha-secret');
    } else if (methodName === 'signInWithIdToken') {
      await api.extensionAuth.signInWithIdToken({ provider: 'oidc', token: 'identity-token' });
      expect(ports.auth.signInWithIdToken).toHaveBeenCalledWith(
        { provider: 'oidc', token: 'identity-token' },
        'captcha-secret',
      );
    }

    expect(provider.getToken).toHaveBeenCalledWith(action);
  });

  it('does not request an unsupported CAPTCHA token for OAuth identity linking', async () => {
    const ports = createPorts();
    const provider: CaptchaProvider = {
      kind: 'test',
      prewarm: jest.fn(),
      getToken: jest.fn().mockResolvedValue({ token: 'captcha-secret', issuedAt: 1 }),
      release: jest.fn(),
      dispose: jest.fn(),
    };
    const api = createExtensionApi({
      auth: ports.auth,
      session: ports.session,
      apiClient: {} as ApiClient,
      captchaProvider: provider,
    });

    await api.extensionAuth.linkIdentity({ provider: 'oidc' });

    expect(ports.auth.linkIdentity).toHaveBeenCalledWith({ provider: 'oidc' }, undefined);
    expect(provider.getToken).not.toHaveBeenCalled();
  });

  it('releases CAPTCHA tokens on auth failures and does not call auth when CAPTCHA fails', async () => {
    const ports = createPorts();
    const captchaToken = { token: 'captcha-secret', issuedAt: 1 };
    const provider: CaptchaProvider = {
      kind: 'test',
      prewarm: jest.fn(),
      getToken: jest.fn().mockResolvedValue(captchaToken),
      release: jest.fn(),
      dispose: jest.fn(),
    };
    const api = createExtensionApi({
      auth: ports.auth,
      session: ports.session,
      apiClient: {} as ApiClient,
      captchaProvider: provider,
    });

    ports.auth.signInAnonymously.mockResolvedValueOnce({ ok: false, error: 'auth.failed' });
    await expect(api.extensionAuth.signInAnonymously()).resolves.toEqual({
      ok: false,
      error: 'auth.failed',
    });
    expect(provider.release).toHaveBeenCalledWith(captchaToken);

    const authError = new Error('Auth adapter failed.');
    ports.auth.signInAnonymously.mockRejectedValueOnce(authError);
    await expect(api.extensionAuth.signInAnonymously()).rejects.toBe(authError);
    expect(provider.release).toHaveBeenCalledTimes(2);
    expect(provider.release).toHaveBeenLastCalledWith(captchaToken);

    provider.getToken = jest.fn().mockRejectedValueOnce(new CaptchaError('timeout'));
    await expect(api.extensionAuth.signInAnonymously()).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(ports.auth.signInAnonymously).toHaveBeenCalledTimes(2);
    expect(provider.release).toHaveBeenCalledTimes(2);
  });

  it('provides a summary hook without exposing session credentials', async () => {
    const ports = createPorts({
      userId: '5fa6acc4-75aa-4e60-8129-3db379c1c804',
      isAnonymous: false,
    });
    const dependencies = {
      auth: ports.auth,
      session: ports.session,
      apiClient: {} as ApiClient,
      captchaProvider: noCaptcha,
    };
    const uninstall = installExtensionApi(dependencies);
    const { result, unmount } = await renderHook(() => useSessionSummary());

    expect(result.current).toEqual({
      userId: '5fa6acc4-75aa-4e60-8129-3db379c1c804',
      isAnonymous: false,
    });
    expect(result.current).not.toHaveProperty('accessToken');

    await act(async () => {
      ports.setSummary(null);
    });
    expect(result.current).toBeNull();
    unmount();
    uninstall();
  });

  it('never renders a previous user summary after the active session port changes', async () => {
    const firstPorts = createPorts({
      userId: '00000000-0000-4000-8000-000000000001',
      isAnonymous: true,
    });
    const secondPorts = createPorts({
      userId: '00000000-0000-4000-8000-000000000002',
      isAnonymous: false,
    });
    const firstCleanup = installExtensionApi({
      auth: firstPorts.auth,
      session: firstPorts.session,
      apiClient: {} as ApiClient,
      captchaProvider: noCaptcha,
    });
    const observed: Array<SessionSummary | null> = [];
    const { result, unmount } = await renderHook(() => {
      const summary = useSessionSummary();
      observed.push(summary);
      return summary;
    });
    expect(result.current?.userId).toBe('00000000-0000-4000-8000-000000000001');
    observed.length = 0;

    let secondCleanup: () => void = () => undefined;
    await act(async () => {
      secondCleanup = installExtensionApi({
        auth: secondPorts.auth,
        session: secondPorts.session,
        apiClient: {} as ApiClient,
        captchaProvider: noCaptcha,
      });
    });
    expect(result.current?.userId).toBe('00000000-0000-4000-8000-000000000002');
    expect(observed.map((summary) => summary?.userId)).not.toContain(
      '00000000-0000-4000-8000-000000000001',
    );

    observed.length = 0;
    await act(async () => secondCleanup());
    expect(result.current?.userId).toBe('00000000-0000-4000-8000-000000000001');
    expect(observed.map((summary) => summary?.userId)).not.toContain(
      '00000000-0000-4000-8000-000000000002',
    );

    unmount();
    firstCleanup();
  });

  it('keeps runtime registration cleanup safe for overlapping providers and StrictMode', async () => {
    const firstPorts = createPorts();
    const secondPorts = createPorts();
    const firstCleanup = installExtensionApi({
      auth: firstPorts.auth,
      session: firstPorts.session,
      apiClient: {} as ApiClient,
      captchaProvider: noCaptcha,
    });
    const secondCleanup = installExtensionApi({
      auth: secondPorts.auth,
      session: secondPorts.session,
      apiClient: {} as ApiClient,
      captchaProvider: noCaptcha,
    });

    await extensionAuth.signInAnonymously();
    expect(secondPorts.auth.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(firstPorts.auth.signInAnonymously).not.toHaveBeenCalled();

    firstCleanup();
    firstCleanup();
    await extensionAuth.signInAnonymously();
    expect(secondPorts.auth.signInAnonymously).toHaveBeenCalledTimes(2);
    expect(firstPorts.auth.signInAnonymously).not.toHaveBeenCalled();

    secondCleanup();
    await expect(extensionAuth.signInAnonymously()).resolves.toEqual({
      ok: false,
      error: 'auth.unavailable',
    });

    const outerCleanup = installExtensionApi({
      auth: firstPorts.auth,
      session: firstPorts.session,
      apiClient: {} as ApiClient,
      captchaProvider: noCaptcha,
    });
    const innerCleanup = installExtensionApi({
      auth: secondPorts.auth,
      session: secondPorts.session,
      apiClient: {} as ApiClient,
      captchaProvider: noCaptcha,
    });
    innerCleanup();
    await extensionAuth.signInAnonymously();
    expect(firstPorts.auth.signInAnonymously).toHaveBeenCalledTimes(1);
    outerCleanup();

    const strictModeSetupCleanup = installExtensionApi({
      auth: firstPorts.auth,
      session: firstPorts.session,
      apiClient: {} as ApiClient,
      captchaProvider: noCaptcha,
    });
    strictModeSetupCleanup();
    const strictModeRemountCleanup = installExtensionApi({
      auth: secondPorts.auth,
      session: secondPorts.session,
      apiClient: {} as ApiClient,
      captchaProvider: noCaptcha,
    });
    await extensionAuth.signInAnonymously();
    expect(secondPorts.auth.signInAnonymously).toHaveBeenCalledTimes(3);
    strictModeRemountCleanup();
  });

  it('disposes a shared CAPTCHA provider only after its final runtime lease ends', async () => {
    const ports = createPorts();
    const provider: CaptchaProvider = {
      kind: 'test',
      prewarm: jest.fn(),
      getToken: jest.fn().mockResolvedValue({ token: 'captcha-secret', issuedAt: 1 }),
      release: jest.fn(),
      dispose: jest.fn(),
    };
    const dependencies = {
      auth: ports.auth,
      session: ports.session,
      apiClient: {} as ApiClient,
      captchaProvider: provider,
    };

    const strictModeFirstCleanup = installExtensionApi(dependencies);
    strictModeFirstCleanup();
    const strictModeRemountCleanup = installExtensionApi(dependencies);
    await Promise.resolve();
    expect(provider.dispose).not.toHaveBeenCalled();

    const sharedCleanup = installExtensionApi(dependencies);
    strictModeRemountCleanup();
    await Promise.resolve();
    expect(provider.dispose).not.toHaveBeenCalled();

    sharedCleanup();
    await Promise.resolve();
    expect(provider.dispose).toHaveBeenCalledTimes(1);
    sharedCleanup();
    await Promise.resolve();
    expect(provider.dispose).toHaveBeenCalledTimes(1);

    const sameTickProvider: CaptchaProvider = {
      kind: 'same-tick',
      prewarm: jest.fn(),
      getToken: jest.fn().mockResolvedValue({ token: 'captcha-secret', issuedAt: 1 }),
      release: jest.fn(),
      dispose: jest.fn(),
    };
    const sameTickDependencies = { ...dependencies, captchaProvider: sameTickProvider };
    const sameTickFirstCleanup = installExtensionApi(sameTickDependencies);
    const sameTickSecondCleanup = installExtensionApi(sameTickDependencies);
    sameTickFirstCleanup();
    sameTickSecondCleanup();
    await Promise.resolve();
    expect(sameTickProvider.dispose).toHaveBeenCalledTimes(1);
  });

  it('fails closed until the app installs configured ports and then serves the named facade', async () => {
    await expect(extensionAuth.signInAnonymously()).resolves.toEqual({
      ok: false,
      error: 'auth.unavailable',
    });
    await expect(extensionApiClient.request({} as never)).rejects.toThrow(
      'Extension API client is unavailable.',
    );

    const ports = createPorts({
      userId: '00000000-0000-4000-8000-000000000001',
      isAnonymous: true,
    });
    const captchaProvider: CaptchaProvider = {
      kind: 'test',
      prewarm: jest.fn(),
      getToken: jest.fn().mockResolvedValue({ token: 'captcha-secret', issuedAt: 1 }),
      release: jest.fn(),
      dispose: jest.fn(),
    };
    const apiClient: jest.Mocked<ApiClient> = {
      request: jest.fn().mockResolvedValue({ ok: true }),
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppProviders
        extensions={[{ name: 'captcha-extension', captchaProvider }]}
        authOperations={ports.auth}
        sessionPort={ports.session}
        apiClient={apiClient}
        initialLocale="pt-BR"
      >
        {children}
      </AppProviders>
    );

    const { result, unmount } = await renderHook(() => useSessionSummary(), { wrapper });
    await expect(extensionAuth.signInAnonymously()).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(ports.auth.signInAnonymously).toHaveBeenCalledWith('captcha-secret');
    expect(captchaProvider.getToken).toHaveBeenCalledWith('anonymous');
    expect(result.current).toEqual({
      userId: '00000000-0000-4000-8000-000000000001',
      isAnonymous: true,
    });

    await expect(extensionApiClient.request({} as never)).resolves.toEqual({ ok: true });
    expect(apiClient.request).toHaveBeenCalledTimes(1);

    unmount();
  });
});
