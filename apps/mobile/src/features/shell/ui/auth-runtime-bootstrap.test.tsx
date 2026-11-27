import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { AppState, Text } from 'react-native';

import AppLayout from '../../../app/(app)/_layout';
import GateLayout from '../../../app/(gates)/_layout';
import {
  AppConfigBootBridge,
  AppProviders,
  AuthRuntimeBootstrap,
  useAppSessionSummary,
  useBootShellState,
  type AppProvidersProps,
} from './app-providers';
import { AppConfigProvider, createDefaultAppConfig, type AppConfigCache } from '../../app-config';

jest.mock('../../../composition/auth-runtime', () => {
  const actual = jest.requireActual('../../../composition/auth-runtime');
  return { ...actual, createAuthRuntime: jest.fn() };
});

jest.mock('expo-router', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const mockNative = jest.requireActual<typeof import('react-native')>('react-native');
  const Screen = ({ name }: { readonly name: string }) =>
    mockReact.createElement(mockNative.Text, { testID: `route.${name}` }, name);
  const Protected = ({
    guard,
    children,
  }: {
    readonly guard: boolean;
    readonly children: React.ReactNode;
  }) => (guard ? mockReact.createElement(mockReact.Fragment, null, children) : null);
  const Stack = Object.assign(
    ({ children }: { readonly children: React.ReactNode }) =>
      mockReact.createElement(mockReact.Fragment, null, children),
    { Screen, Protected },
  );
  return { Stack };
});

const userId = '123e4567-e89b-42d3-a456-426614174000';
type Controller = NonNullable<AppProvidersProps['authRuntime']>['controller'];
type Snapshot = ReturnType<Controller['getSnapshot']>;
const profile: NonNullable<Snapshot['me']> = {
  id: userId,
  email: 'person@example.invalid',
  displayName: null,
  locale: 'en',
  createdAt: '2026-11-26T00:00:00.000Z',
  consents: { needsAcceptance: [] },
};

type RevalidationResult =
  | { readonly ok: true; readonly value: undefined }
  | { readonly ok: false; readonly error: 'auth.unavailable' };
type ProfileReadResult =
  | { readonly ok: true; readonly value: NonNullable<Snapshot['me']> }
  | { readonly ok: false; readonly error: 'auth.unavailable' };

function createRuntime(
  refreshedProfile = profile,
  revalidate: (notifySessionRefresh: () => void) => Promise<RevalidationResult> = async () => ({
    ok: true,
    value: undefined,
  }),
  initialProfile: NonNullable<Snapshot['me']> | null = null,
  readProfile: () => Promise<ProfileReadResult> = async () => ({
    ok: true,
    value: refreshedProfile,
  }),
) {
  const callOrder: string[] = [];
  let snapshot: Snapshot = {
    accessStatus: 'signed_in',
    session: { userId, isAnonymous: false },
    authMethod: 'email_password',
    flow: { kind: 'idle' },
    isBusy: false,
    error: null,
    me: initialProfile,
    needsConsent: [...(initialProfile?.consents.needsAcceptance ?? [])],
    resendSecondsRemaining: 0,
  };
  const listeners = new Set<() => void>();
  const sessionListeners = new Set<() => void>();
  const notifySessionRefresh = () => {
    for (const listener of sessionListeners) listener();
  };
  const controller = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refreshMe: jest.fn(async () => {
      const expectedUserId = snapshot.session?.userId;
      const revalidated = await revalidateSession();
      if (!revalidated.ok || snapshot.session?.userId !== expectedUserId) return revalidated;
      callOrder.push('me');
      const profileResult = await readProfile();
      if (!profileResult.ok) return profileResult;
      snapshot = {
        ...snapshot,
        me: profileResult.value,
        needsConsent: [...profileResult.value.consents.needsAcceptance],
      };
      for (const listener of listeners) listener();
      return profileResult;
    }),
  };
  const revalidateSession = jest.fn(async () => {
    callOrder.push('revalidate');
    return revalidate(notifySessionRefresh);
  });
  const setSessionUserId = (nextUserId: string) => {
    snapshot = {
      ...snapshot,
      session: { userId: nextUserId, isAnonymous: false },
      me: null,
      needsConsent: [],
    };
    for (const listener of listeners) listener();
    for (const listener of sessionListeners) listener();
  };
  const session = {
    getCurrentAccessToken: async () => null,
    getSessionSummary: () => snapshot.session,
    revalidate: revalidateSession,
    subscribe: (listener: () => void) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    signOutLocal: async () => undefined,
    capturePreviousSession: async () => null,
  };
  const runtime = {
    controller,
    auth: {},
    operations: {},
    session,
    account: {},
    apiClient: {},
  } as unknown as NonNullable<AppProvidersProps['authRuntime']>;
  return {
    runtime,
    controller,
    revalidateSession,
    callOrder,
    setSessionUserId,
    notifySessionRefresh,
  };
}

function BootProbe() {
  const boot = useBootShellState();
  const session = useAppSessionSummary();
  return (
    <Text testID="boot-status">
      {`${String(boot.offline)}:${String(boot.termsAccepted)}:${session?.userId ?? 'none'}`}
    </Text>
  );
}

const config = createDefaultAppConfig();
const runtimeFactory = jest.requireMock('../../../composition/auth-runtime') as {
  readonly createAuthRuntime: jest.Mock;
};
const cache: AppConfigCache = {
  read: async () => config,
  write: async () => undefined,
  clear: async () => undefined,
};

beforeEach(() => {
  runtimeFactory.createAuthRuntime.mockReset();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockReturnValue({ remove: jest.fn() } as ReturnType<typeof AppState.addEventListener>);
});

describe('Auth runtime boot recovery', () => {
  it('refreshes consent state when a saved offline session reconnects', async () => {
    const { runtime, controller, revalidateSession, callOrder } = createRuntime();
    const tree = (online: boolean) => (
      <AppProviders extensions={[]} environment={{}} initialLocale="en" authRuntime={runtime}>
        <AppConfigProvider
          reader={async () => config}
          cache={cache}
          appVersion="1.0.0"
          platform="ios"
          onlineOverride={online}
          foregroundOverride
        >
          <AppConfigBootBridge>
            <AuthRuntimeBootstrap>
              <BootProbe />
              <GateLayout />
              <AppLayout />
            </AuthRuntimeBootstrap>
          </AppConfigBootBridge>
        </AppConfigProvider>
      </AppProviders>
    );

    const view = await render(tree(false));
    expect(await view.findByText(`true:false:${userId}`)).toBeTruthy();
    expect(controller.refreshMe).not.toHaveBeenCalled();
    expect(view.getByTestId('route.(tabs)')).toBeTruthy();
    expect(view.queryByTestId('route.terms')).toBeNull();

    await act(async () => view.rerender(tree(true)));
    expect(await view.findByText(`false:true:${userId}`)).toBeTruthy();
    expect(view.getByTestId('route.(tabs)')).toBeTruthy();
    expect(view.queryByTestId('route.terms')).toBeNull();
    expect(controller.refreshMe).toHaveBeenCalledTimes(1);
    expect(revalidateSession).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['revalidate', 'me']);
    await view.unmount();
  });

  it('keeps consent gated when an offline saved session reconnects with pending consent', async () => {
    const pendingConsentProfile = {
      ...profile,
      consents: { needsAcceptance: ['terms', 'privacy'] },
    } satisfies NonNullable<Snapshot['me']>;
    const { runtime, controller, revalidateSession, callOrder } =
      createRuntime(pendingConsentProfile);
    const tree = (online: boolean) => (
      <AppProviders extensions={[]} environment={{}} initialLocale="en" authRuntime={runtime}>
        <AppConfigProvider
          reader={async () => config}
          cache={cache}
          appVersion="1.0.0"
          platform="ios"
          onlineOverride={online}
          foregroundOverride
        >
          <AppConfigBootBridge>
            <AuthRuntimeBootstrap>
              <BootProbe />
              <GateLayout />
              <AppLayout />
            </AuthRuntimeBootstrap>
          </AppConfigBootBridge>
        </AppConfigProvider>
      </AppProviders>
    );

    const view = await render(tree(false));
    expect(await view.findByText(`true:false:${userId}`)).toBeTruthy();
    expect(controller.refreshMe).not.toHaveBeenCalled();
    expect(view.getByTestId('route.(tabs)')).toBeTruthy();
    expect(view.queryByTestId('route.terms')).toBeNull();

    await act(async () => view.rerender(tree(true)));
    expect(await view.findByText(`false:false:${userId}`)).toBeTruthy();
    expect(controller.refreshMe).toHaveBeenCalledTimes(1);
    expect(revalidateSession).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['revalidate', 'me']);
    expect(controller.getSnapshot().needsConsent).toEqual(['terms', 'privacy']);
    expect(view.getByTestId('route.terms')).toBeTruthy();
    expect(view.queryByTestId('route.(tabs)')).toBeNull();
    await view.unmount();
  });

  it('does not request /v1/me after session revalidation fails transiently', async () => {
    const { runtime, controller, revalidateSession, callOrder } = createRuntime(
      profile,
      async () => ({ ok: false, error: 'auth.unavailable' }),
    );
    const tree = (online: boolean) => (
      <AppProviders extensions={[]} environment={{}} initialLocale="en" authRuntime={runtime}>
        <AppConfigProvider
          reader={async () => config}
          cache={cache}
          appVersion="1.0.0"
          platform="ios"
          onlineOverride={online}
          foregroundOverride
        >
          <AppConfigBootBridge>
            <AuthRuntimeBootstrap>
              <BootProbe />
              <GateLayout />
              <AppLayout />
            </AuthRuntimeBootstrap>
          </AppConfigBootBridge>
        </AppConfigProvider>
      </AppProviders>
    );

    const view = await render(tree(false));
    expect(await view.findByText(`true:false:${userId}`)).toBeTruthy();
    await act(async () => view.rerender(tree(true)));

    expect(await view.findByText(`false:false:${userId}`)).toBeTruthy();
    expect(revalidateSession).toHaveBeenCalledTimes(1);
    expect(controller.refreshMe).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['revalidate']);
    expect(view.getByTestId('route.terms')).toBeTruthy();
    expect(view.queryByTestId('route.(tabs)')).toBeNull();
    await view.unmount();
  });

  it('refreshes cached consent state after reconnecting with an already loaded profile', async () => {
    const remotePendingProfile = {
      ...profile,
      consents: { needsAcceptance: ['terms'] },
    } satisfies NonNullable<Snapshot['me']>;
    const cachedProfile = {
      ...profile,
      consents: { needsAcceptance: [] },
    } satisfies NonNullable<Snapshot['me']>;
    const { runtime, controller, callOrder } = createRuntime(
      remotePendingProfile,
      undefined,
      cachedProfile,
    );
    const tree = (online: boolean) => (
      <AppProviders extensions={[]} environment={{}} initialLocale="en" authRuntime={runtime}>
        <AppConfigProvider
          reader={async () => config}
          cache={cache}
          appVersion="1.0.0"
          platform="ios"
          onlineOverride={online}
          foregroundOverride
        >
          <AppConfigBootBridge>
            <AuthRuntimeBootstrap>
              <BootProbe />
              <GateLayout />
              <AppLayout />
            </AuthRuntimeBootstrap>
          </AppConfigBootBridge>
        </AppConfigProvider>
      </AppProviders>
    );

    const view = await render(tree(false));
    expect(await view.findByText(`true:true:${userId}`)).toBeTruthy();
    expect(view.getByTestId('route.(tabs)')).toBeTruthy();

    await act(async () => view.rerender(tree(true)));

    expect(await view.findByText(`false:false:${userId}`)).toBeTruthy();
    expect(callOrder).toEqual(['revalidate', 'me']);
    expect(controller.getSnapshot().needsConsent).toEqual(['terms']);
    expect(view.getByTestId('route.terms')).toBeTruthy();
    expect(view.queryByTestId('route.(tabs)')).toBeNull();
    await view.unmount();
  });

  it('retries profile loading after a session refresh without another network transition', async () => {
    let revalidationCount = 0;
    const { runtime, controller, revalidateSession, callOrder, notifySessionRefresh } =
      createRuntime(profile, async () => {
        revalidationCount += 1;
        return revalidationCount === 1
          ? { ok: false, error: 'auth.unavailable' }
          : { ok: true, value: undefined };
      });
    const tree = (online: boolean) => (
      <AppProviders extensions={[]} environment={{}} initialLocale="en" authRuntime={runtime}>
        <AppConfigProvider
          reader={async () => config}
          cache={cache}
          appVersion="1.0.0"
          platform="ios"
          onlineOverride={online}
          foregroundOverride
        >
          <AppConfigBootBridge>
            <AuthRuntimeBootstrap>
              <BootProbe />
              <GateLayout />
              <AppLayout />
            </AuthRuntimeBootstrap>
          </AppConfigBootBridge>
        </AppConfigProvider>
      </AppProviders>
    );

    const view = await render(tree(false));
    expect(await view.findByText(`true:false:${userId}`)).toBeTruthy();
    await act(async () => view.rerender(tree(true)));
    expect(revalidateSession).toHaveBeenCalledTimes(1);
    expect(controller.refreshMe).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['revalidate']);
    expect(view.getByTestId('route.terms')).toBeTruthy();
    expect(view.queryByTestId('route.(tabs)')).toBeNull();

    await act(async () => notifySessionRefresh());

    expect(await view.findByText(`false:true:${userId}`)).toBeTruthy();
    expect(revalidateSession).toHaveBeenCalledTimes(2);
    expect(controller.refreshMe).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(['revalidate', 'revalidate', 'me']);
    expect(view.queryByTestId('route.terms')).toBeNull();
    expect(view.getByTestId('route.(tabs)')).toBeTruthy();
    await view.unmount();
  });

  it('retries the managed runtime profile gate after an auth session refresh while still online', async () => {
    let revalidationCount = 0;
    const { runtime, controller, revalidateSession, callOrder, notifySessionRefresh } =
      createRuntime(profile, async () => {
        revalidationCount += 1;
        return revalidationCount === 1
          ? { ok: false, error: 'auth.unavailable' }
          : { ok: true, value: undefined };
      });
    runtimeFactory.createAuthRuntime.mockResolvedValue(runtime);
    const tree = (
      <AppProviders extensions={[]} environment={{}} initialLocale="en">
        <AppConfigProvider
          reader={async () => config}
          cache={cache}
          appVersion="1.0.0"
          platform="ios"
          onlineOverride
          foregroundOverride
        >
          <AppConfigBootBridge>
            <AuthRuntimeBootstrap>
              <BootProbe />
              <GateLayout />
              <AppLayout />
            </AuthRuntimeBootstrap>
          </AppConfigBootBridge>
        </AppConfigProvider>
      </AppProviders>
    );

    const view = await render(tree);
    expect(await view.findByText(`false:false:${userId}`)).toBeTruthy();
    expect(runtimeFactory.createAuthRuntime).toHaveBeenCalledTimes(1);
    expect(revalidateSession).toHaveBeenCalledTimes(1);
    expect(controller.refreshMe).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['revalidate']);
    expect(view.getByTestId('route.terms')).toBeTruthy();
    expect(view.queryByTestId('route.(tabs)')).toBeNull();

    await act(async () => notifySessionRefresh());

    expect(await view.findByText(`false:true:${userId}`)).toBeTruthy();
    expect(revalidateSession).toHaveBeenCalledTimes(2);
    expect(controller.refreshMe).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(['revalidate', 'revalidate', 'me']);
    expect(view.queryByTestId('route.terms')).toBeNull();
    expect(view.getByTestId('route.(tabs)')).toBeTruthy();
    await view.unmount();
  });

  it('consumes session revisions emitted by its own refresh when /v1/me fails', async () => {
    const { runtime, controller, revalidateSession, callOrder, notifySessionRefresh } =
      createRuntime(
        profile,
        async (notify) => {
          notify();
          return { ok: true, value: undefined };
        },
        null,
        async () => ({ ok: false, error: 'auth.unavailable' }),
      );
    runtimeFactory.createAuthRuntime.mockResolvedValue(runtime);
    const tree = (
      <AppProviders extensions={[]} environment={{}} initialLocale="en">
        <AppConfigProvider
          reader={async () => config}
          cache={cache}
          appVersion="1.0.0"
          platform="ios"
          onlineOverride
          foregroundOverride
        >
          <AppConfigBootBridge>
            <AuthRuntimeBootstrap>
              <BootProbe />
              <GateLayout />
              <AppLayout />
            </AuthRuntimeBootstrap>
          </AppConfigBootBridge>
        </AppConfigProvider>
      </AppProviders>
    );

    const view = await render(tree);
    expect(await view.findByText(`false:false:${userId}`)).toBeTruthy();
    await waitFor(() => expect(controller.refreshMe).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(revalidateSession).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['revalidate', 'me']);
    expect(controller.getSnapshot().me).toBeNull();
    expect(view.getByTestId('route.terms')).toBeTruthy();

    await act(async () => notifySessionRefresh());
    await waitFor(() => expect(controller.refreshMe).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(revalidateSession).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(['revalidate', 'me', 'revalidate', 'me']);
    expect(controller.getSnapshot().me).toBeNull();
    await view.unmount();
  });
});
