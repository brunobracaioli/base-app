import type { Session, SupabaseClient } from '@supabase/supabase-js';

import type { SessionSummary } from '../../../extensions/types';
import type { AuthStorage } from './encrypted-storage';
import {
  createSupabaseAuthAdapter,
  createSupabaseAuthAdapterWithDependencies,
} from './supabase-auth-adapter';
import { getSupabaseStorageKey } from './supabase-client';

const userA = '123e4567-e89b-42d3-a456-426614174000';
const userB = '223e4567-e89b-42d3-a456-426614174001';

function makeSession(userId: string): Session {
  return {
    access_token: `access-${userId}`,
    refresh_token: `refresh-${userId}`,
    token_type: 'bearer',
    expires_in: 900,
    expires_at: 1_900_000_000,
    user: { id: userId, is_anonymous: false },
  } as Session;
}

function createMemoryStorage() {
  const values = new Map<string, string>();
  const storage: AuthStorage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
  return { storage, values };
}

type FakeAuthError = {
  readonly name?: string;
  readonly code?: string;
  readonly status?: number;
};

function createFakeClient(options: {
  readonly initialSession?: Session | null;
  readonly signInSession?: Session | null;
  readonly verifySession?: Session | null;
  readonly verifyError?: { readonly code: string } | null;
  readonly signOutOthersError?: { readonly code: string } | null;
  readonly getSessionError?: FakeAuthError | null;
  readonly nullSessionOnGetSessionError?: boolean;
  readonly refreshError?: FakeAuthError | null;
}) {
  let currentSession = options.initialSession ?? null;
  const listeners = new Set<(event: string, session: Session | null) => void>();
  const sessionsByAccessToken = new Map<string, Session>();
  for (const candidate of [options.initialSession, options.signInSession, options.verifySession]) {
    if (candidate !== undefined && candidate !== null) {
      sessionsByAccessToken.set(candidate.access_token, candidate);
    }
  }
  const emit = (event: string, session: Session | null) => {
    for (const listener of listeners) listener(event, session);
  };
  const setCurrentSession = (session: Session | null) => {
    currentSession = session;
    emit(session === null ? 'SIGNED_OUT' : 'SIGNED_IN', session);
  };
  const auth = {
    onAuthStateChange: jest.fn((listener: (event: string, session: Session | null) => void) => {
      listeners.add(listener);
      return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
    }),
    getSession: jest.fn(async () => ({
      data: {
        session:
          options.getSessionError != null && options.nullSessionOnGetSessionError
            ? null
            : currentSession,
      },
      error: options.getSessionError ?? null,
    })),
    signOut: jest.fn(async (input?: { readonly scope?: string }) => {
      if (input?.scope === 'others') {
        return { data: {}, error: options.signOutOthersError ?? null };
      }
      setCurrentSession(null);
      return { data: {}, error: null };
    }),
    setSession: jest.fn(async (input: { readonly access_token: string }) => {
      const restored = sessionsByAccessToken.get(input.access_token) ?? null;
      setCurrentSession(restored);
      return {
        data: { session: restored },
        error: restored === null ? { code: 'session_not_found' } : null,
      };
    }),
    signInWithIdToken: jest.fn(async () => {
      const signedIn = options.signInSession ?? null;
      setCurrentSession(signedIn);
      return {
        data: { session: signedIn },
        error: signedIn === null ? { code: 'invalid_credentials' } : null,
      };
    }),
    signInWithPassword: jest.fn(async () => {
      const signedIn = options.signInSession ?? null;
      setCurrentSession(signedIn);
      return {
        data: { session: signedIn },
        error: signedIn === null ? { code: 'invalid_credentials' } : null,
      };
    }),
    signInWithOtp: jest.fn(async () => ({ data: { user: null, session: null }, error: null })),
    verifyOtp: jest.fn(async () => {
      const verified = options.verifySession ?? null;
      if (verified !== null) setCurrentSession(verified);
      return {
        data: { user: verified?.user ?? null, session: verified },
        error: options.verifyError ?? null,
      };
    }),
    resetPasswordForEmail: jest.fn(async () => ({ data: {}, error: null })),
    resend: jest.fn(async () => ({ data: {}, error: null })),
    reauthenticate: jest.fn(async () => ({ data: {}, error: null })),
    updateUser: jest.fn(async () => ({
      data: { user: currentSession?.user ?? null },
      error: null,
    })),
    refreshSession: jest.fn(async () => ({
      data: { session: currentSession },
      error: options.refreshError ?? null,
    })),
    getUserIdentities: jest.fn(async () => ({ data: { identities: [] }, error: null })),
    unlinkIdentity: jest.fn(async () => ({ data: {}, error: null })),
    startAutoRefresh: jest.fn(),
    stopAutoRefresh: jest.fn(),
  };

  return {
    client: { auth } as unknown as SupabaseClient,
    auth,
    emit,
    setCurrentSession,
    sessionsByAccessToken,
    getCurrentSession: () => currentSession,
  };
}

function createAdapter(
  primary: ReturnType<typeof createFakeClient>,
  createSecondaryClient: () => ReturnType<typeof createFakeClient>,
  storage: AuthStorage = createMemoryStorage().storage,
) {
  return createSupabaseAuthAdapterWithDependencies({
    supabaseUrl: 'https://project.example.invalid',
    publishableKey: 'public-key',
    captchaProvider: null,
    recentAuthMaxAgeSec: () => 300,
    storage,
    createPrimaryClient: () => primary.client,
    createSecondaryClient: () => createSecondaryClient().client,
  });
}

describe('Supabase Auth adapter session isolation', () => {
  it('does not expose the raw Supabase client through the public adapter factory', () => {
    const adapter = createSupabaseAuthAdapter({
      supabaseUrl: 'https://project.example.invalid',
      publishableKey: 'public-key',
      captchaProvider: null,
      recentAuthMaxAgeSec: () => 300,
    });

    expect(adapter).not.toHaveProperty('client');
    adapter.dispose();
  });

  it('keeps an expired session local during an offline startup refresh and restores it after reconnect', async () => {
    const storage = createMemoryStorage();
    const storageKey = getSupabaseStorageKey('https://project.example.invalid');
    const expiredSession = {
      ...makeSession(userA),
      expires_in: -1,
      expires_at: Math.floor(Date.now() / 1000) - 1,
    };
    await storage.storage.setItem(storageKey, JSON.stringify(expiredSession));
    const retryableError: FakeAuthError = { name: 'AuthRetryableFetchError', status: 0 };
    const primary = createFakeClient({
      initialSession: expiredSession,
      getSessionError: retryableError,
      nullSessionOnGetSessionError: true,
      refreshError: retryableError,
    });
    const adapter = createAdapter(primary, () => createFakeClient({}), storage.storage);

    try {
      await adapter.initialize();

      expect(adapter.session.getSessionSummary()).toEqual({ userId: userA, isAnonymous: false });
      primary.emit('INITIAL_SESSION', null);
      expect(adapter.session.getSessionSummary()).toEqual({ userId: userA, isAnonymous: false });
      expect(await storage.storage.getItem(storageKey)).toBe(JSON.stringify(expiredSession));
      expect(await adapter.session.getCurrentAccessToken()).toBeNull();
      await expect(adapter.getAuthContext()).resolves.toEqual({ accessToken: null, userId: null });
      await expect(adapter.operations.refreshSession()).resolves.toEqual({
        ok: false,
        error: 'auth.unavailable',
      });
      await expect(adapter.session.revalidate?.()).resolves.toEqual({
        ok: false,
        error: 'auth.unavailable',
      });
      expect(adapter.session.getSessionSummary()).toEqual({ userId: userA, isAnonymous: false });
      expect(await storage.storage.getItem(storageKey)).toBe(JSON.stringify(expiredSession));

      const refreshedSession = makeSession(userA);
      refreshedSession.access_token = 'fresh-access-token';
      refreshedSession.refresh_token = 'rotated-refresh-token';
      primary.setCurrentSession(refreshedSession);
      await storage.storage.setItem(storageKey, JSON.stringify(refreshedSession));
      primary.auth.getSession.mockImplementation(async () => ({
        data: { session: primary.getCurrentSession() },
        error: null,
      }));
      await expect(adapter.session.revalidate?.()).resolves.toEqual({
        ok: true,
        value: undefined,
      });
      await expect(adapter.session.getCurrentAccessToken()).resolves.toBe('fresh-access-token');
      expect(adapter.session.getSessionSummary()).toEqual({ userId: userA, isAnonymous: false });
      expect(await storage.storage.getItem(storageKey)).toContain('rotated-refresh-token');
    } finally {
      adapter.dispose();
    }
  });

  it('clears an expired session when auth-js rejects its refresh token', async () => {
    const storage = createMemoryStorage();
    const storageKey = getSupabaseStorageKey('https://project.example.invalid');
    const expiredSession = {
      ...makeSession(userA),
      expires_in: -1,
      expires_at: Math.floor(Date.now() / 1000) - 1,
    };
    await storage.storage.setItem(storageKey, JSON.stringify(expiredSession));
    const primary = createFakeClient({
      initialSession: expiredSession,
      getSessionError: { name: 'AuthApiError', code: 'invalid_refresh_token', status: 400 },
      nullSessionOnGetSessionError: true,
    });
    const adapter = createAdapter(primary, () => createFakeClient({}), storage.storage);

    try {
      await adapter.initialize();

      expect(adapter.session.getSessionSummary()).toBeNull();
      expect(await storage.storage.getItem(storageKey)).toBeNull();
      await expect(adapter.session.getCurrentAccessToken()).resolves.toBeNull();
    } finally {
      adapter.dispose();
    }
  });

  it('ignores a late initial null event but honors an explicit signed-out event', async () => {
    const storage = createMemoryStorage();
    const storageKey = getSupabaseStorageKey('https://project.example.invalid');
    const expiredSession = {
      ...makeSession(userA),
      expires_in: -1,
      expires_at: Math.floor(Date.now() / 1000) - 1,
    };
    await storage.storage.setItem(storageKey, JSON.stringify(expiredSession));
    const primary = createFakeClient({
      initialSession: expiredSession,
      getSessionError: { name: 'AuthRetryableFetchError', status: 0 },
      nullSessionOnGetSessionError: true,
    });
    const adapter = createAdapter(primary, () => createFakeClient({}), storage.storage);
    await adapter.initialize();

    primary.emit('INITIAL_SESSION', null);
    expect(adapter.session.getSessionSummary()).toEqual({ userId: userA, isAnonymous: false });

    primary.emit('SIGNED_OUT', null);
    expect(adapter.session.getSessionSummary()).toBeNull();
    adapter.dispose();
  });

  it('does not restore a session when initialization finishes after sign-out', async () => {
    const storage = createMemoryStorage();
    const storageKey = getSupabaseStorageKey('https://project.example.invalid');
    const storedSession = makeSession(userA);
    await storage.storage.setItem(storageKey, JSON.stringify(storedSession));
    const primary = createFakeClient({ initialSession: storedSession });
    let resolveGetSession!: (value: {
      readonly data: { readonly session: Session | null };
      readonly error: null;
    }) => void;
    let markGetSessionStarted!: () => void;
    const getSessionStarted = new Promise<void>((resolve) => {
      markGetSessionStarted = resolve;
    });
    primary.auth.getSession.mockImplementation(async () => {
      markGetSessionStarted();
      return new Promise((resolve) => {
        resolveGetSession = resolve;
      });
    });
    const adapter = createAdapter(primary, () => createFakeClient({}), storage.storage);

    const initialization = adapter.initialize();
    await getSessionStarted;
    await adapter.session.signOutLocal();
    resolveGetSession({ data: { session: storedSession }, error: null });
    await initialization;

    expect(adapter.session.getSessionSummary()).toBeNull();
    expect(await storage.storage.getItem(storageKey)).toBeNull();
    adapter.dispose();
  });

  it('does not publish a stale refresh after a different account starts signing in', async () => {
    const storage = createMemoryStorage();
    const storageKey = getSupabaseStorageKey('https://project.example.invalid');
    const expiredSession = {
      ...makeSession(userA),
      expires_in: -1,
      expires_at: Math.floor(Date.now() / 1000) - 1,
    };
    await storage.storage.setItem(storageKey, JSON.stringify(expiredSession));
    const primary = createFakeClient({
      initialSession: expiredSession,
      signInSession: makeSession(userB),
      getSessionError: { name: 'AuthRetryableFetchError', status: 0 },
      nullSessionOnGetSessionError: true,
    });
    let resolveRefresh!: (value: {
      readonly data: { readonly session: Session | null };
      readonly error: null;
    }) => void;
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    primary.auth.refreshSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
          markRefreshStarted();
        }),
    );
    const adapter = createAdapter(primary, () => createFakeClient({}), storage.storage);
    await adapter.initialize();
    const observedSessions: Array<string | null> = [];
    const unsubscribe = adapter.session.subscribe(() => {
      observedSessions.push(adapter.session.getSessionSummary()?.userId ?? null);
    });

    const refresh = adapter.operations.refreshSession();
    await refreshStarted;
    const signIn = adapter.auth.signInWithPassword({
      email: 'other@example.invalid',
      password: 'Password123',
    });
    resolveRefresh({ data: { session: expiredSession }, error: null });

    await expect(refresh).resolves.toEqual({ ok: false, error: 'auth.failed' });
    await expect(signIn).resolves.toEqual({ ok: true, value: undefined });
    expect(observedSessions).not.toContain(userA);
    expect(adapter.session.getSessionSummary()).toEqual({ userId: userB, isAnonymous: false });
    unsubscribe();
    adapter.dispose();
  });

  it('does not restore a stored session when the adapter is disposed during initialization', async () => {
    const storage = createMemoryStorage();
    const storageKey = getSupabaseStorageKey('https://project.example.invalid');
    const storedSession = makeSession(userA);
    await storage.storage.setItem(storageKey, JSON.stringify(storedSession));
    const primary = createFakeClient({ initialSession: storedSession });
    let resolveGetSession!: (value: {
      readonly data: { readonly session: Session | null };
      readonly error: null;
    }) => void;
    let markGetSessionStarted!: () => void;
    const getSessionStarted = new Promise<void>((resolve) => {
      markGetSessionStarted = resolve;
    });
    primary.auth.getSession.mockImplementation(async () => {
      markGetSessionStarted();
      return new Promise((resolve) => {
        resolveGetSession = resolve;
      });
    });
    const adapter = createAdapter(primary, () => createFakeClient({}), storage.storage);

    const initialization = adapter.initialize();
    await getSessionStarted;
    adapter.dispose();
    resolveGetSession({ data: { session: storedSession }, error: null });
    await initialization;

    expect(adapter.session.getSessionSummary()).toBeNull();
    expect(await storage.storage.getItem(storageKey)).toBe(JSON.stringify(storedSession));
  });

  it('fences a late extension sign-in after logout and accepts a later explicit sign-in', async () => {
    const primary = createFakeClient({ initialSession: null, signInSession: makeSession(userB) });
    const adapter = createAdapter(primary, () => createFakeClient({}));
    let resolveSignIn!: (value: {
      readonly data: { readonly session: Session | null };
      readonly error: { readonly code: string } | null;
    }) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const staleSession = makeSession(userA);
    primary.auth.signInWithIdToken.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSignIn = resolve;
          markStarted();
        }),
    );

    const lateLogin = adapter.operations.signInWithIdToken(
      { provider: 'apple', token: 'private-id-token' },
      undefined,
    );
    await started;
    const logout = adapter.session.signOutLocal();
    primary.setCurrentSession(staleSession);
    resolveSignIn({ data: { session: staleSession }, error: null });

    await expect(lateLogin).resolves.toMatchObject({ ok: false });
    await expect(logout).resolves.toBeUndefined();
    expect(adapter.session.getSessionSummary()).toBeNull();

    primary.auth.signInWithIdToken.mockImplementation(async () => {
      const signedIn = makeSession(userB);
      primary.setCurrentSession(signedIn);
      return { data: { session: signedIn }, error: null };
    });
    await expect(
      adapter.operations.signInWithIdToken(
        { provider: 'apple', token: 'new-private-id-token' },
        undefined,
      ),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(adapter.session.getSessionSummary()).toEqual({ userId: userB, isAnonymous: false });
    adapter.dispose();
  });

  it('does not change the primary session when step-up authenticates another user', async () => {
    const primary = createFakeClient({ initialSession: makeSession(userA) });
    const secondary = createFakeClient({ signInSession: makeSession(userB) });
    const adapter = createAdapter(primary, () => secondary);
    await adapter.initialize();

    await expect(
      adapter.auth.stepUpWithPassword({
        email: 'person@example.invalid',
        password: 'Password123',
        expectedUserId: userA,
      }),
    ).resolves.toEqual({ ok: true, value: { sameUser: false } });

    expect(adapter.session.getSessionSummary()).toEqual({ userId: userA, isAnonymous: false });
    expect(primary.auth.signOut).not.toHaveBeenCalled();
    expect(primary.auth.setSession).not.toHaveBeenCalled();
    expect(secondary.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    adapter.dispose();
  });

  it('does not install a step-up session that finishes after logout', async () => {
    const oldSession = makeSession(userA);
    const primary = createFakeClient({ initialSession: oldSession });
    const secondary = createFakeClient({ signInSession: oldSession });
    const adapter = createAdapter(primary, () => secondary);
    await adapter.initialize();
    let resolveStepUp!: (value: {
      readonly data: { readonly session: Session | null };
      readonly error: { readonly code: string } | null;
    }) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    secondary.auth.signInWithPassword.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStepUp = resolve;
          markStarted();
        }),
    );

    const pendingStepUp = adapter.auth.stepUpWithPassword({
      email: 'person@example.invalid',
      password: 'Password123',
      expectedUserId: userA,
    });
    await started;
    await adapter.session.signOutLocal();
    secondary.setCurrentSession(oldSession);
    resolveStepUp({ data: { session: oldSession }, error: null });

    await expect(pendingStepUp).resolves.toMatchObject({ ok: false });
    expect(primary.auth.setSession).not.toHaveBeenCalled();
    expect(adapter.session.getSessionSummary()).toBeNull();
    expect(secondary.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    adapter.dispose();
  });

  it('revokes the old primary session before same-user step-up and does not sign out the transferred session', async () => {
    const restored = makeSession(userA);
    const primary = createFakeClient({ initialSession: restored });
    primary.sessionsByAccessToken.set(restored.access_token, restored);
    const secondary = createFakeClient({ signInSession: restored });
    const adapter = createAdapter(primary, () => secondary);
    await adapter.initialize();

    await expect(
      adapter.auth.stepUpWithPassword({
        email: 'person@example.invalid',
        password: 'Password123',
        expectedUserId: userA,
      }),
    ).resolves.toEqual({ ok: true, value: { sameUser: true } });

    expect(primary.auth.signOut.mock.invocationCallOrder[0]).toBeLessThan(
      primary.auth.setSession.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(primary.auth.setSession).toHaveBeenCalledWith({
      access_token: restored.access_token,
      refresh_token: restored.refresh_token,
    });
    expect(secondary.auth.signOut).not.toHaveBeenCalled();
    expect(adapter.session.getSessionSummary()).toEqual({ userId: userA, isAnonymous: false });
    adapter.dispose();
  });

  it('keeps signup sessions provisional, discards them on restart, and promotes only after password setup', async () => {
    const signupSession = makeSession(userA);
    const primary = createFakeClient({ initialSession: null });
    const provisional = createFakeClient({ verifySession: signupSession });
    primary.sessionsByAccessToken.set(signupSession.access_token, signupSession);
    const adapter = createAdapter(primary, () => provisional);

    await expect(
      adapter.auth.verifyEmailCode({
        email: 'person@example.invalid',
        code: '0123456789',
        purpose: 'sign_up',
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(adapter.auth.getPendingPasswordSetup()).toBe('sign_up');
    expect(adapter.session.getSessionSummary()).toBeNull();

    const restarted = createAdapter(createFakeClient({}), () => createFakeClient({}));
    expect(restarted.auth.getPendingPasswordSetup()).toBeNull();
    restarted.dispose();

    await expect(
      adapter.auth.updatePassword({ password: 'Password123', purpose: 'setup' }),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(adapter.auth.getPendingPasswordSetup()).toBeNull();
    expect(adapter.session.getSessionSummary()).toEqual({ userId: userA, isAnonymous: false });
    expect(provisional.auth.signOut).not.toHaveBeenCalled();
    expect(provisional.auth.signOut).not.toHaveBeenCalledWith({ scope: 'others' });
    adapter.dispose();
  });

  it('prevents a newer recovery verification from replacing a session being promoted', async () => {
    const signupSession = makeSession(userA);
    const primary = createFakeClient({ initialSession: null });
    const provisional = createFakeClient({ verifySession: signupSession });
    primary.sessionsByAccessToken.set(signupSession.access_token, signupSession);
    const adapter = createAdapter(primary, () => provisional);
    await adapter.auth.verifyEmailCode({
      email: 'person@example.invalid',
      code: '0123456789',
      purpose: 'sign_up',
    });
    let resolveUpdate!: (value: {
      readonly data: { readonly user: Session['user'] };
      readonly error: null;
    }) => void;
    let markUpdateStarted!: () => void;
    const updateStarted = new Promise<void>((resolve) => {
      markUpdateStarted = resolve;
    });
    provisional.auth.updateUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
          markUpdateStarted();
        }),
    );

    const pendingPasswordSetup = adapter.auth.updatePassword({
      password: 'Password123',
      purpose: 'setup',
    });
    await updateStarted;
    await expect(
      adapter.auth.sendPasswordResetCode({ email: 'other@example.invalid', locale: 'en' }),
    ).resolves.toEqual({ ok: false, error: 'auth.failed' });
    expect(primary.auth.resetPasswordForEmail).not.toHaveBeenCalled();
    await expect(
      adapter.auth.verifyEmailCode({
        email: 'other@example.invalid',
        code: '0123456789',
        purpose: 'recovery',
      }),
    ).resolves.toEqual({ ok: false, error: 'auth.failed' });
    resolveUpdate({ data: { user: signupSession.user }, error: null });

    await expect(pendingPasswordSetup).resolves.toEqual({ ok: true, value: undefined });
    expect(adapter.session.getSessionSummary()).toEqual({ userId: userA, isAnonymous: false });
    expect(adapter.auth.getPendingPasswordSetup()).toBeNull();
    adapter.dispose();
  });

  it('revokes other sessions before promoting a recovered password session', async () => {
    const recoverySession = makeSession(userA);
    const primary = createFakeClient({ initialSession: null });
    const recoveryClient = createFakeClient({ verifySession: recoverySession });
    const storage = createMemoryStorage();
    primary.sessionsByAccessToken.set(recoverySession.access_token, recoverySession);
    recoveryClient.auth.updateUser.mockImplementation(async () => {
      expect(storage.values.has('base-app.auth-recovery-revocations.v1')).toBe(true);
      return { data: { user: recoverySession.user }, error: null };
    });
    const adapter = createAdapter(primary, () => recoveryClient, storage.storage);

    await adapter.auth.verifyEmailCode({
      email: 'person@example.invalid',
      code: '0123456789',
      purpose: 'recovery',
    });
    await expect(
      adapter.auth.updatePassword({ password: 'Password123', purpose: 'recovery' }),
    ).resolves.toEqual({ ok: true, value: undefined });

    expect(recoveryClient.auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
    expect(recoveryClient.getCurrentSession()?.user.id).toBe(userA);
    expect(recoveryClient.auth.signOut.mock.invocationCallOrder[0]).toBeLessThan(
      primary.auth.setSession.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(adapter.session.getSessionSummary()).toEqual({ userId: userA, isAnonymous: false });
    expect(adapter.auth.getPendingPasswordSetup()).toBeNull();
    expect(storage.values.has('base-app.auth-recovery-revocations.v1')).toBe(false);
    adapter.dispose();
  });

  it('revokes other sessions after recovery and retries from an encrypted marker after restart', async () => {
    const recoverySession = makeSession(userA);
    const primary = createFakeClient({ initialSession: null });
    const recoveryClient = createFakeClient({ verifySession: recoverySession });
    const storage = createMemoryStorage();
    primary.sessionsByAccessToken.set(recoverySession.access_token, recoverySession);
    recoveryClient.auth.signOut.mockImplementation(async (input) => {
      if (input?.scope === 'others') return { data: {}, error: { code: 'network_error' } };
      recoveryClient.setCurrentSession(null);
      return { data: {}, error: null };
    });
    const adapter = createAdapter(primary, () => recoveryClient, storage.storage);

    await adapter.auth.verifyEmailCode({
      email: 'person@example.invalid',
      code: '0123456789',
      purpose: 'recovery',
    });
    await expect(
      adapter.auth.updatePassword({ password: 'Password123', purpose: 'recovery' }),
    ).resolves.toEqual({ ok: false, error: 'auth.failed' });
    const marker = storage.values.get('base-app.auth-recovery-revocations.v1');
    expect(marker).toContain(userA);
    expect(adapter.auth.getPendingPasswordSetup()).toBe('recovery');
    expect(adapter.session.getSessionSummary()).toBeNull();
    adapter.dispose();

    const unrelatedPrimary = createFakeClient({ initialSession: makeSession(userB) });
    const unrelated = createAdapter(unrelatedPrimary, () => createFakeClient({}), storage.storage);
    await unrelated.initialize();
    expect(unrelatedPrimary.auth.signOut).not.toHaveBeenCalledWith({ scope: 'others' });
    expect(storage.values.has('base-app.auth-recovery-revocations.v1')).toBe(true);
    unrelated.dispose();

    const restoredPrimary = createFakeClient({ initialSession: recoverySession });
    const restarted = createAdapter(restoredPrimary, () => createFakeClient({}), storage.storage);
    await restarted.initialize();

    expect(restoredPrimary.auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
    expect(restarted.session.getSessionSummary()).toEqual({ userId: userA, isAnonymous: false });
    expect(storage.values.has('base-app.auth-recovery-revocations.v1')).toBe(false);
    restarted.dispose();

    storage.values.set(
      'base-app.auth-recovery-revocations.v1',
      JSON.stringify({ userIds: [userA] }),
    );
    const loginPrimary = createFakeClient({ initialSession: null, signInSession: recoverySession });
    let loginAdapter: ReturnType<typeof createSupabaseAuthAdapter> | null = null;
    let summaryAtRevocation: SessionSummary | null | undefined;
    loginPrimary.auth.signOut.mockImplementation(async (input) => {
      if (input?.scope === 'others') {
        summaryAtRevocation = loginAdapter?.session.getSessionSummary() ?? null;
        return { data: {}, error: null };
      }
      loginPrimary.setCurrentSession(null);
      return { data: {}, error: null };
    });
    loginAdapter = createAdapter(loginPrimary, () => createFakeClient({}), storage.storage);
    await loginAdapter.initialize();
    await expect(
      loginAdapter.auth.signInWithPassword({
        email: 'person@example.invalid',
        password: 'Password123',
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(summaryAtRevocation).toBeNull();
    expect(loginPrimary.auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
    expect(loginAdapter.session.getSessionSummary()).toEqual({ userId: userA, isAnonymous: false });
    expect(storage.values.has('base-app.auth-recovery-revocations.v1')).toBe(false);
    loginAdapter.dispose();
  });

  it('does not change a recovery password when the revocation marker cannot be stored', async () => {
    const recoverySession = makeSession(userA);
    const primary = createFakeClient({ initialSession: null });
    const recoveryClient = createFakeClient({ verifySession: recoverySession });
    const storage = createMemoryStorage();
    primary.sessionsByAccessToken.set(recoverySession.access_token, recoverySession);
    let allowMarkerWrite = false;
    const guardedStorage: AuthStorage = {
      ...storage.storage,
      setItem: async (key, value) => {
        if (key === 'base-app.auth-recovery-revocations.v1' && !allowMarkerWrite) {
          throw new Error('storage unavailable');
        }
        await storage.storage.setItem(key, value);
      },
    };
    const adapter = createAdapter(primary, () => recoveryClient, guardedStorage);
    await adapter.auth.verifyEmailCode({
      email: 'person@example.invalid',
      code: '0123456789',
      purpose: 'recovery',
    });

    await expect(
      adapter.auth.updatePassword({ password: 'Password123', purpose: 'recovery' }),
    ).resolves.toEqual({ ok: false, error: 'auth.failed' });
    expect(recoveryClient.auth.updateUser).not.toHaveBeenCalled();
    expect(primary.auth.setSession).not.toHaveBeenCalled();

    allowMarkerWrite = true;
    recoveryClient.auth.updateUser.mockImplementation(async () => {
      expect(storage.values.has('base-app.auth-recovery-revocations.v1')).toBe(true);
      return { data: { user: recoverySession.user }, error: null };
    });
    await expect(
      adapter.auth.updatePassword({ password: 'Password123', purpose: 'recovery' }),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(recoveryClient.auth.updateUser).toHaveBeenCalledTimes(1);
    expect(primary.auth.setSession).toHaveBeenCalledTimes(1);
    expect(storage.values.has('base-app.auth-recovery-revocations.v1')).toBe(false);
    adapter.dispose();
  });

  it('does not attach a failed recovery OTP to the previously active session', async () => {
    const primary = createFakeClient({ initialSession: makeSession(userA) });
    const provisional = createFakeClient({ verifyError: { code: 'invalid_code' } });
    const adapter = createAdapter(primary, () => provisional);
    await adapter.initialize();

    await expect(
      adapter.auth.verifyEmailCode({
        email: 'person@example.invalid',
        code: '0123456789',
        purpose: 'recovery',
      }),
    ).resolves.toEqual({ ok: false, error: 'auth.failed' });
    expect(adapter.auth.getPendingPasswordSetup()).toBeNull();
    expect(adapter.session.getSessionSummary()).toEqual({ userId: userA, isAnonymous: false });
    expect(provisional.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    adapter.dispose();
  });

  it('captures a prior session in an isolated client and never signs out the new primary session', async () => {
    const previous = makeSession(userA);
    const primary = createFakeClient({
      initialSession: previous,
      signInSession: makeSession(userB),
    });
    const secondary = createFakeClient({ initialSession: previous });
    const stored = createMemoryStorage();
    await stored.storage.setItem(
      getSupabaseStorageKey('https://project.example.invalid'),
      JSON.stringify(previous),
    );
    const adapter = createAdapter(primary, () => secondary, stored.storage);
    await adapter.initialize();

    const captured = await adapter.session.capturePreviousSession();
    expect(captured).not.toBeNull();
    await expect(captured?.getAccessToken()).resolves.toBe(previous.access_token);
    await expect(
      adapter.operations.signInWithIdToken(
        { provider: 'apple', token: 'new-private-id-token' },
        undefined,
      ),
    ).resolves.toEqual({ ok: true, value: undefined });

    await captured?.signOutLocal();
    expect(adapter.session.getSessionSummary()).toEqual({ userId: userB, isAnonymous: false });
    expect(primary.getCurrentSession()?.user.id).toBe(userB);
    expect(secondary.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    adapter.dispose();
  });

  it('clears the primary session only when a stale API response matches its user', async () => {
    const primary = createFakeClient({ initialSession: makeSession(userB) });
    const adapter = createAdapter(primary, () => createFakeClient({}));
    await adapter.initialize();

    await expect(adapter.signOutLocalIfUserMatches(userA)).resolves.toBe(false);
    expect(primary.getCurrentSession()?.user.id).toBe(userB);
    expect(primary.auth.signOut).not.toHaveBeenCalled();

    await expect(adapter.signOutLocalIfUserMatches(userB)).resolves.toBe(true);
    expect(primary.getCurrentSession()).toBeNull();
    expect(adapter.session.getSessionSummary()).toBeNull();
    adapter.dispose();
  });

  it('does not clear the new user snapshot or query cache in the account-deleted callback gap', async () => {
    const primary = createFakeClient({
      initialSession: makeSession(userA),
      signInSession: makeSession(userB),
    });
    const adapter = createAdapter(primary, () => createFakeClient({}));
    await adapter.initialize();

    await expect(adapter.signOutLocalIfUserMatches(userA)).resolves.toBe(true);
    await expect(
      adapter.operations.signInWithIdToken(
        { provider: 'apple', token: 'new-private-id-token' },
        undefined,
      ),
    ).resolves.toEqual({ ok: true, value: undefined });

    const clearQueryCache = jest.fn();
    const deletedUserCleanup = async (userId: string | null) => {
      if (userId !== null && adapter.handleAccountDeleted(userId)) clearQueryCache();
    };
    await deletedUserCleanup(userA);

    expect(clearQueryCache).not.toHaveBeenCalled();
    expect(adapter.session.getSessionSummary()).toEqual({ userId: userB, isAnonymous: false });
    adapter.dispose();
  });

  it('keeps another user provisional setup when the previous account deletion callback arrives late', async () => {
    const primary = createFakeClient({ initialSession: makeSession(userA) });
    const provisional = createFakeClient({ verifySession: makeSession(userB) });
    const adapter = createAdapter(primary, () => provisional);
    await adapter.initialize();
    await expect(adapter.signOutLocalIfUserMatches(userA)).resolves.toBe(true);
    await expect(
      adapter.auth.verifyEmailCode({
        email: 'other@example.invalid',
        code: '0123456789',
        purpose: 'sign_up',
      }),
    ).resolves.toEqual({ ok: true, value: undefined });

    expect(adapter.handleAccountDeleted(userA)).toBe(false);
    expect(adapter.auth.getPendingPasswordSetup()).toBe('sign_up');
    expect(primary.getCurrentSession()).toBeNull();
    adapter.dispose();
  });
});
