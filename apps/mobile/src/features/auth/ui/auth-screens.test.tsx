import { act, fireEvent, render, screen } from '@testing-library/react-native';
import React, { type PropsWithChildren } from 'react';
import { AppState } from 'react-native';

import type {
  AppConfigResponseValue,
  ConsentBodyInput,
  MeResponse,
  UpdateProfileBodyInput,
} from '@base-app/contracts';
import type { Locale, SessionSummary } from '../../../extensions/types';
import type { ApiClient } from '../../../shared/api-client';
import type { AuthRuntimeHandle } from '../../../composition/auth-runtime';
import { AppProviders } from '../../shell/ui/app-providers';
import { AppConfigProvider, type AppConfigCache, type AppConfigReader } from '../../app-config';
import {
  createAuthController,
  type AccountApiPort,
  type AuthCodePurpose,
  type AuthController,
  type AuthTransportPort,
  type EmailCodePurpose,
  type PasswordChangePurpose,
  type PasswordSetupPurpose,
  type StepUpMethod,
} from '..';
import { SettingsScreen } from '../../shell/ui/settings-screen';
import { unavailableAuthOperations } from '../model/auth-ports';
import type { SessionPort } from '../model/auth-ports';
import AuthLayout from '../../../app/(auth)/_layout';
import AppLayout from '../../../app/(app)/_layout';
import GateLayout from '../../../app/(gates)/_layout';
import {
  AccountProfileScreen,
  ChangeEmailScreen,
  ChangePasswordScreen,
  EmailCodeScreen,
  PasswordSetupScreen,
  PasswordSignInScreen,
  ReauthenticationScreen,
  SignUpScreen,
  TermsConsentScreen,
} from './auth-screens';

jest.mock('expo-router', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const mockNative = jest.requireActual<typeof import('react-native')>('react-native');
  const router = {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => true),
  };
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
  return { useRouter: () => router, __router: router, Stack };
});

jest.mock('expo-screen-capture', () => ({ usePreventScreenCapture: jest.fn() }));
jest.mock('expo-application', () => ({ nativeApplicationVersion: '1.0.0' }));
jest.mock('react-native-safe-area-context', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const mockNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaProvider: ({ children }: PropsWithChildren) => children,
    SafeAreaView: ({ children }: PropsWithChildren) =>
      mockReact.createElement(mockNative.View, null, children),
  };
});

type RouterMock = {
  readonly push: jest.Mock;
  readonly replace: jest.Mock;
  readonly back: jest.Mock;
  readonly canGoBack: jest.Mock;
};

const router = (jest.requireMock('expo-router') as { readonly __router: RouterMock }).__router;
const testUserId = '5fa6acc4-75aa-4e60-8129-3db379c1c804';
const testNow = Date.parse('2026-11-26T12:00:00.000Z');

type FixtureOptions = {
  readonly authenticated?: boolean;
  readonly authMethod?: StepUpMethod | null;
  readonly recentAuth?: boolean;
  readonly needsConsent?: readonly ('terms' | 'privacy')[];
  readonly pendingPasswordSetup?: PasswordSetupPurpose | null;
  readonly failMe?: boolean;
};

type Fixture = {
  readonly runtime: AuthRuntimeHandle;
  readonly controller: AuthController;
  readonly authCalls: {
    readonly emailCodes: Array<{
      readonly email: string;
      readonly locale: Locale;
      readonly purpose: EmailCodePurpose | AuthCodePurpose | 'password_change' | 'password_reset';
    }>;
    readonly verifiedEmailCodes: Array<{
      readonly email: string;
      readonly code: string;
      readonly purpose: string;
    }>;
    readonly passwordUpdates: Array<{
      readonly password: string;
      readonly purpose: PasswordChangePurpose;
      readonly nonce?: string;
    }>;
    readonly locales: Locale[];
    readonly emailChanges: string[];
    readonly signOuts: Array<'local' | 'global'>;
  };
  readonly accountCalls: {
    readonly profileUpdates: UpdateProfileBodyInput[];
    readonly consents: ConsentBodyInput[];
  };
  readonly setRecentAuth: (recent: boolean) => void;
  readonly rejectNextPasswordChange: () => void;
  readonly failNextPrivacyConsent: () => void;
  readonly setMeReadFailure: (fail: boolean) => void;
  readonly dispose: () => void;
};

function makeMe(needsConsent: readonly ('terms' | 'privacy')[] = []): MeResponse {
  return {
    id: testUserId,
    email: 'person@example.test',
    displayName: null,
    locale: 'en',
    createdAt: '2026-11-26T00:00:00.000Z',
    consents: { needsAcceptance: [...needsConsent] },
  };
}

function createFixture(options: FixtureOptions = {}): Fixture {
  let currentSession: SessionSummary | null = options.authenticated
    ? { userId: testUserId, isAnonymous: false }
    : null;
  let activeMethod = options.authMethod ?? null;
  let pendingPasswordSetup: PasswordSetupPurpose | null = options.pendingPasswordSetup ?? null;
  let recentlyAuthenticated = options.recentAuth ?? true;
  let me = makeMe(options.needsConsent);
  let rejectPasswordChange = false;
  let failPrivacyConsent = false;
  let failMeRead = options.failMe ?? false;
  const sessionListeners = new Set<() => void>();
  const authCalls: Fixture['authCalls'] = {
    emailCodes: [],
    verifiedEmailCodes: [],
    passwordUpdates: [],
    locales: [],
    emailChanges: [],
    signOuts: [],
  };
  const accountCalls: Fixture['accountCalls'] = { profileUpdates: [], consents: [] };
  const auth: AuthTransportPort = {
    getCurrentAuthMethod: () => activeMethod,
    getPendingPasswordSetup: () => pendingPasswordSetup,
    isRecentlyAuthenticated: () => recentlyAuthenticated,
    sendEmailCode: async ({ email, locale, purpose }) => {
      authCalls.emailCodes.push({ email, locale, purpose });
      return { ok: true, value: undefined };
    },
    verifyEmailCode: async ({ email, code, purpose }) => {
      authCalls.verifiedEmailCodes.push({ email, code, purpose });
      currentSession = { userId: testUserId, isAnonymous: false };
      if (purpose === 'sign_up' || purpose === 'recovery') pendingPasswordSetup = purpose;
      for (const listener of [...sessionListeners]) listener();
      return { ok: true, value: undefined };
    },
    signInWithPassword: async () => {
      currentSession = { userId: testUserId, isAnonymous: false };
      activeMethod = 'email_password';
      for (const listener of [...sessionListeners]) listener();
      return { ok: true, value: undefined };
    },
    sendPasswordResetCode: async ({ email, locale }) => {
      authCalls.emailCodes.push({ email, locale, purpose: 'password_reset' });
      return { ok: true, value: undefined };
    },
    sendPasswordChangeCode: async ({ email, locale }) => {
      authCalls.emailCodes.push({ email, locale, purpose: 'password_change' });
      return { ok: true, value: undefined };
    },
    resendEmailChangeCode: async () => ({ ok: true, value: undefined }),
    updatePassword: async ({ password, purpose, nonce }) => {
      authCalls.passwordUpdates.push({
        password,
        purpose,
        ...(nonce === undefined ? {} : { nonce }),
      });
      if (purpose === 'change' && rejectPasswordChange) {
        rejectPasswordChange = false;
        return { ok: false, error: 'auth.failed' };
      }
      pendingPasswordSetup = null;
      activeMethod = purpose === 'change' ? activeMethod : 'email_password';
      return { ok: true, value: undefined };
    },
    updateLocale: async (locale) => {
      authCalls.locales.push(locale);
      return { ok: true, value: undefined };
    },
    beginEmailChange: async ({ email }) => {
      authCalls.emailChanges.push(email);
      return { ok: true, value: undefined };
    },
    verifyEmailChangeCode: async ({ email, code }) => {
      authCalls.verifiedEmailCodes.push({ email, code, purpose: 'email_change' });
      if (email !== me.email) me = { ...me, email };
      return { ok: true, value: undefined };
    },
    stepUpWithPassword: async ({ expectedUserId }) => ({
      ok: true,
      value: { sameUser: expectedUserId === testUserId },
    }),
    verifyStepUpCode: async ({ expectedUserId, email, code }) => {
      authCalls.verifiedEmailCodes.push({ email, code, purpose: 'step_up' });
      return { ok: true, value: { sameUser: expectedUserId === testUserId } };
    },
    signOut: async (scope) => {
      authCalls.signOuts.push(scope);
      currentSession = null;
      activeMethod = null;
      for (const listener of [...sessionListeners]) listener();
      return { ok: true, value: undefined };
    },
  };
  const account: AccountApiPort = {
    getMe: async () => (failMeRead ? { ok: false, error: 'auth.failed' } : { ok: true, value: me }),
    updateMe: async (input) => {
      accountCalls.profileUpdates.push(input);
      me = {
        ...me,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.locale === undefined ? {} : { locale: input.locale }),
      };
      return { ok: true, value: me };
    },
    acceptConsent: async (input) => {
      accountCalls.consents.push(input);
      if (input.document === 'privacy' && failPrivacyConsent) {
        failPrivacyConsent = false;
        return { ok: false, error: 'auth.failed' };
      }
      me = {
        ...me,
        consents: {
          needsAcceptance: me.consents.needsAcceptance.filter(
            (document) => document !== input.document,
          ),
        },
      };
      return { ok: true, value: undefined };
    },
  };
  const session: SessionPort = {
    getCurrentAccessToken: async () => null,
    getSessionSummary: () => currentSession,
    subscribe: (listener) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    signOutLocal: async () => {
      currentSession = null;
      for (const listener of [...sessionListeners]) listener();
    },
    capturePreviousSession: async () => null,
  };
  const controller = createAuthController({
    auth,
    account,
    session,
    now: () => testNow,
    locale: () => 'en',
    recentAuthMaxAgeSec: () => 300,
  });
  const runtime: AuthRuntimeHandle = {
    controller,
    auth,
    operations: unavailableAuthOperations,
    session,
    account,
    apiClient: {} as ApiClient,
  };

  return {
    runtime,
    controller,
    authCalls,
    accountCalls,
    setRecentAuth(recent) {
      recentlyAuthenticated = recent;
    },
    rejectNextPasswordChange() {
      rejectPasswordChange = true;
    },
    failNextPrivacyConsent() {
      failPrivacyConsent = true;
    },
    setMeReadFailure(fail) {
      failMeRead = fail;
    },
    dispose: () => controller.dispose(),
  };
}

function RuntimeHarness({
  fixture,
  children,
  locale = 'en',
  bootOffline = false,
}: PropsWithChildren<{
  readonly fixture: Fixture;
  readonly locale?: Locale;
  readonly bootOffline?: boolean;
}>) {
  return (
    <AppProviders
      extensions={[]}
      authRuntime={fixture.runtime}
      initialLocale={locale}
      bootState={{
        updateRequired: false,
        maintenance: false,
        termsAccepted: false,
        offline: bootOffline,
        extensionBlock: null,
      }}
    >
      {children}
    </AppProviders>
  );
}

const config: AppConfigResponseValue = {
  versions: {
    ios: { minSupported: '0.0.0', latest: '2.0.0', storeUrl: 'https://apps.apple.com/app/id1' },
    android: {
      minSupported: '0.0.0',
      latest: '2.0.0',
      storeUrl: 'https://play.google.com/store/apps/details?id=com.example.app',
    },
  },
  maintenance: {
    active: false,
    platforms: ['ios', 'android'],
    messageKey: 'maintenance.default',
    until: null,
  },
  legal: {
    termsVersion: '2026-11-25',
    privacyVersion: '2026-11-26',
    termsUrl: 'https://myapp.example.invalid/terms',
    privacyUrl: 'https://myapp.example.invalid/privacy',
  },
};

function makeConfigCache(): AppConfigCache {
  return { read: async () => config, write: async () => undefined, clear: async () => undefined };
}

function TermsHarness({ fixture }: { readonly fixture: Fixture }) {
  const reader: AppConfigReader = async () => config;
  return (
    <RuntimeHarness fixture={fixture}>
      <AppConfigProvider
        reader={reader}
        cache={makeConfigCache()}
        appVersion="1.0.0"
        platform="ios"
        onlineOverride
        foregroundOverride
      >
        <TermsConsentScreen />
      </AppConfigProvider>
    </RuntimeHarness>
  );
}

beforeEach(() => {
  router.push.mockClear();
  router.replace.mockClear();
  router.back.mockClear();
  router.canGoBack.mockReturnValue(true);
  jest
    .spyOn(AppState, 'addEventListener')
    .mockReturnValue({ remove: jest.fn() } as ReturnType<typeof AppState.addEventListener>);
});

describe('authentication screens', () => {
  it('keeps the terms retry route available offline while profile state is unknown', async () => {
    const fixture = createFixture({ authenticated: true, failMe: true });
    await fixture.controller.refreshMe();
    const view = await render(
      <RuntimeHarness fixture={fixture} bootOffline>
        <GateLayout />
        <AppLayout />
      </RuntimeHarness>,
    );
    expect(screen.getByTestId('route.terms')).toBeTruthy();
    expect(screen.queryByTestId('route.(tabs)')).toBeNull();
    await view.unmount();
    fixture.dispose();
  });

  it('opens the product routes after both current consents are accepted', async () => {
    const fixture = createFixture({ authenticated: true, needsConsent: ['terms', 'privacy'] });
    await fixture.controller.refreshMe();
    const view = await render(
      <RuntimeHarness fixture={fixture}>
        <GateLayout />
        <AppLayout />
      </RuntimeHarness>,
    );
    expect(screen.getByTestId('route.terms')).toBeTruthy();
    expect(screen.queryByTestId('route.(tabs)')).toBeNull();

    await act(async () => {
      await fixture.controller.acceptConsent({ document: 'terms', version: '2026-11-25' });
      await fixture.controller.acceptConsent({ document: 'privacy', version: '2026-11-26' });
    });
    expect(screen.queryByTestId('route.terms')).toBeNull();
    expect(screen.getByTestId('route.(tabs)')).toBeTruthy();
    await view.unmount();
    fixture.dispose();
  });

  it('keeps password-setup sessions in auth without a terms gate', async () => {
    const fixture = createFixture({ authenticated: true, pendingPasswordSetup: 'sign_up' });
    const view = await render(
      <RuntimeHarness fixture={fixture}>
        <AuthLayout />
        <GateLayout />
        <AppLayout />
      </RuntimeHarness>,
    );
    expect(screen.getByTestId('route.new-password')).toBeTruthy();
    expect(screen.queryByTestId('route.terms')).toBeNull();
    expect(screen.queryByTestId('route.(tabs)')).toBeNull();
    await view.unmount();
    fixture.dispose();
  });

  it('registers with email OTP first, then sets the password after code confirmation', async () => {
    const fixture = createFixture();
    const view = await render(
      <RuntimeHarness fixture={fixture}>
        <SignUpScreen />
      </RuntimeHarness>,
    );
    await fireEvent.changeText(screen.getByTestId('auth.email'), '  New.User@Example.com ');
    await fireEvent.press(screen.getByTestId('auth.submit'));

    expect(fixture.authCalls.emailCodes).toEqual([
      { email: 'new.user@example.com', locale: 'en', purpose: 'sign_up' },
    ]);
    expect(router.push).toHaveBeenCalledWith('/(auth)/code');
    expect(router.push).toHaveBeenCalledTimes(1);

    await view.rerender(
      <RuntimeHarness fixture={fixture}>
        <EmailCodeScreen />
      </RuntimeHarness>,
    );
    await fireEvent.changeText(screen.getByTestId('auth.otp'), '0123456789');
    await fireEvent.press(screen.getByTestId('auth.submit'));
    expect(fixture.authCalls.verifiedEmailCodes).toEqual([
      { email: 'new.user@example.com', code: '0123456789', purpose: 'sign_up' },
    ]);
    const verifiedFlow = fixture.controller.getSnapshot().flow;
    expect({
      kind: verifiedFlow.kind,
      purpose: verifiedFlow.kind === 'password_setup' ? verifiedFlow.purpose : null,
    }).toEqual({ kind: 'password_setup', purpose: 'sign_up' });
    expect(router.replace).toHaveBeenCalledWith('/(auth)/new-password');

    await view.rerender(
      <RuntimeHarness fixture={fixture}>
        <PasswordSetupScreen />
      </RuntimeHarness>,
    );
    await fireEvent.changeText(screen.getByTestId('auth.new-password'), 'LongEnough123');
    await fireEvent.changeText(screen.getByTestId('auth.confirm-password'), 'LongEnough123');
    await fireEvent.press(screen.getByTestId('auth.submit'));

    expect(fixture.authCalls.passwordUpdates).toEqual([
      { password: 'LongEnough123', purpose: 'setup' },
    ]);
    expect(router.replace).toHaveBeenLastCalledWith('/(app)/(tabs)');
    await view.unmount();
    fixture.dispose();
  });

  it('shows translated password validation errors before calling the auth port', async () => {
    const fixture = createFixture();
    const view = await render(
      <RuntimeHarness fixture={fixture}>
        <PasswordSignInScreen />
      </RuntimeHarness>,
    );
    await fireEvent.changeText(screen.getByTestId('auth.email'), 'person@example.test');
    await fireEvent.changeText(screen.getByTestId('auth.password'), 'short');
    await fireEvent.press(screen.getByTestId('auth.submit'));
    expect(screen.getByText('The password must contain at least 10 characters.')).toBeTruthy();
    expect(fixture.authCalls.passwordUpdates).toHaveLength(0);
    await view.unmount();
    fixture.dispose();
  });

  it('returns control after same-user step-up without replaying an action', async () => {
    const fixture = createFixture({
      authenticated: true,
      authMethod: 'email_otp',
      recentAuth: false,
    });
    await fixture.controller.refreshMe();
    const view = await render(
      <RuntimeHarness fixture={fixture}>
        <ReauthenticationScreen />
      </RuntimeHarness>,
    );
    await fireEvent.press(screen.getByTestId('auth.submit'));
    expect(fixture.authCalls.emailCodes).toHaveLength(1);
    await fireEvent.changeText(screen.getByTestId('auth.reauth.code'), '1234567890');
    await fireEvent.press(screen.getByTestId('auth.submit'));
    expect(fixture.authCalls.verifiedEmailCodes).toEqual([
      { email: 'person@example.test', code: '1234567890', purpose: 'step_up' },
    ]);
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
    await view.unmount();
    fixture.dispose();
  });

  it('stages password-change code as a nonce and permits correction after a rejected update', async () => {
    const fixture = createFixture({
      authenticated: true,
      authMethod: 'email_password',
      recentAuth: true,
    });
    fixture.rejectNextPasswordChange();
    await fixture.controller.refreshMe();
    const view = await render(
      <RuntimeHarness fixture={fixture}>
        <ChangePasswordScreen />
      </RuntimeHarness>,
    );
    await fireEvent.press(screen.getByTestId('auth.change-password.start'));
    await fireEvent.changeText(screen.getByTestId('auth.change-password.code'), '1234567890');
    await fireEvent.press(screen.getByTestId('auth.stage-code'));
    expect(screen.getByTestId('auth.new-password')).toBeTruthy();
    expect(screen.queryByText('Code verified.')).toBeNull();

    await fireEvent.changeText(screen.getByTestId('auth.new-password'), 'FirstPassword123');
    await fireEvent.changeText(screen.getByTestId('auth.confirm-password'), 'FirstPassword123');
    await fireEvent.press(screen.getByTestId('auth.submit'));
    expect(fixture.authCalls.passwordUpdates[0]).toEqual({
      password: 'FirstPassword123',
      purpose: 'change',
      nonce: '1234567890',
    });

    await view.rerender(
      <RuntimeHarness fixture={fixture}>
        <ChangePasswordScreen />
      </RuntimeHarness>,
    );
    expect(screen.getByTestId('auth.change-password.code')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('auth.change-password.code'), '0987654321');
    await fireEvent.press(screen.getByTestId('auth.stage-code'));
    await fireEvent.changeText(screen.getByTestId('auth.new-password'), 'SecondPassword123');
    await fireEvent.changeText(screen.getByTestId('auth.confirm-password'), 'SecondPassword123');
    await fireEvent.press(screen.getByTestId('auth.submit'));
    expect(fixture.authCalls.passwordUpdates[1]).toEqual({
      password: 'SecondPassword123',
      purpose: 'change',
      nonce: '0987654321',
    });
    expect(screen.getByTestId('auth.password-updated')).toBeTruthy();
    await view.unmount();
    fixture.dispose();
  });

  it('requires confirmation at both email addresses before showing the change as complete', async () => {
    const fixture = createFixture({
      authenticated: true,
      authMethod: 'email_otp',
      recentAuth: true,
    });
    await fixture.controller.refreshMe();
    const view = await render(
      <RuntimeHarness fixture={fixture}>
        <ChangeEmailScreen />
      </RuntimeHarness>,
    );
    await fireEvent.changeText(
      screen.getByTestId('auth.change-email.address'),
      'updated@example.test',
    );
    await fireEvent.press(screen.getByTestId('auth.submit'));
    expect(fixture.authCalls.emailChanges).toEqual(['updated@example.test']);

    await fireEvent.changeText(screen.getByTestId('auth.change-email.code'), '1111111111');
    await fireEvent.press(screen.getByTestId('auth.submit'));
    expect(fixture.authCalls.verifiedEmailCodes).toEqual([
      { email: 'person@example.test', code: '1111111111', purpose: 'email_change' },
    ]);
    expect(screen.queryByText('Email updated.')).toBeNull();

    await fireEvent.changeText(screen.getByTestId('auth.change-email.code'), '2222222222');
    await fireEvent.press(screen.getByTestId('auth.submit'));
    expect(fixture.authCalls.verifiedEmailCodes).toEqual([
      { email: 'person@example.test', code: '1111111111', purpose: 'email_change' },
      { email: 'updated@example.test', code: '2222222222', purpose: 'email_change' },
    ]);
    expect(screen.getByText('Email updated.')).toBeTruthy();
    await view.unmount();
    fixture.dispose();
  });

  it('records both current consent versions and retries a partial save safely', async () => {
    const fixture = createFixture({ authenticated: true, needsConsent: ['terms', 'privacy'] });
    fixture.failNextPrivacyConsent();
    const view = await render(<TermsHarness fixture={fixture} />);
    expect(await screen.findByTestId('privacy.checkbox.terms')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('privacy.accept'));
    expect(fixture.accountCalls.consents).toHaveLength(0);

    await fireEvent.press(screen.getByTestId('privacy.checkbox.terms'));
    await fireEvent.press(screen.getByTestId('privacy.checkbox.notice'));
    await fireEvent.press(screen.getByTestId('privacy.accept'));
    expect(fixture.accountCalls.consents.slice(0, 2)).toEqual([
      { document: 'terms', version: '2026-11-25' },
      { document: 'privacy', version: '2026-11-26' },
    ]);
    expect(screen.getByText(/Some choices were saved/)).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('privacy.accept'));
    expect(fixture.accountCalls.consents).toEqual([
      { document: 'terms', version: '2026-11-25' },
      { document: 'privacy', version: '2026-11-26' },
      { document: 'terms', version: '2026-11-25' },
      { document: 'privacy', version: '2026-11-26' },
    ]);
    expect(router.replace).toHaveBeenLastCalledWith('/(app)/(tabs)');
    await view.unmount();
    fixture.dispose();
  });

  it('persists locale and wires settings navigation and global sign-out', async () => {
    const fixture = createFixture({ authenticated: true, authMethod: 'email_password' });
    await fixture.controller.refreshMe();
    const view = await render(
      <RuntimeHarness fixture={fixture}>
        <SettingsScreen />
      </RuntimeHarness>,
    );
    await fireEvent.press(screen.getByTestId('settings.manage-account'));
    expect(router.push).toHaveBeenCalledWith('/(app)/settings/account');
    await fireEvent.press(screen.getByTestId('settings.locale.es'));
    expect(fixture.accountCalls.profileUpdates).toContainEqual({ locale: 'es' });
    expect(fixture.authCalls.locales).toEqual(['es']);
    expect(await screen.findByText('Configuración')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings.sign-out-all'));
    expect(fixture.authCalls.signOuts).toEqual(['global']);
    expect(router.replace).toHaveBeenLastCalledWith('/(auth)/welcome');
    await view.unmount();
    fixture.dispose();
  });

  it('wires sign-out on this device to local scope', async () => {
    const fixture = createFixture({ authenticated: true, authMethod: 'email_otp' });
    await fixture.controller.refreshMe();
    const view = await render(
      <RuntimeHarness fixture={fixture}>
        <SettingsScreen />
      </RuntimeHarness>,
    );
    await fireEvent.press(screen.getByTestId('settings.sign-out'));
    expect(fixture.authCalls.signOuts).toEqual(['local']);
    expect(router.replace).toHaveBeenCalledWith('/(auth)/welcome');
    await view.unmount();
    fixture.dispose();
  });

  it('saves account profile changes through the controller', async () => {
    const fixture = createFixture({ authenticated: true });
    await fixture.controller.refreshMe();
    const view = await render(
      <RuntimeHarness fixture={fixture}>
        <AccountProfileScreen />
      </RuntimeHarness>,
    );
    expect(await screen.findByTestId('settings.display-name')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('settings.display-name'), 'Avery Example');
    await fireEvent.press(screen.getByTestId('settings.save-profile'));
    expect(fixture.accountCalls.profileUpdates).toContainEqual({ displayName: 'Avery Example' });
    await fireEvent.press(screen.getByTestId('settings.change-email'));
    expect(router.push).toHaveBeenCalledWith('/(app)/settings/change-email');
    await fireEvent.press(screen.getByTestId('settings.change-password'));
    expect(router.push).toHaveBeenLastCalledWith('/(app)/settings/change-password');
    await view.unmount();
    fixture.dispose();
  });
});
