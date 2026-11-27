import product from '@base-app/config/product.config';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { useAppConfig } from '../../app-config';
import {
  normalizeEmail,
  validateOtpCode,
  validatePassword,
  type AuthController,
  type AuthFieldError,
  type AuthSnapshot,
  type StepUpMethod,
} from '..';
import { useOptionalAuthRuntime } from '../../../composition/auth-runtime';
import { ScreenCaptureGuard } from '../../shell/ui/screen-capture-guard';
import { translateMobile } from '../../../shared/i18n';
import { openExternalUrl } from '../../../shared/urls';
import { useTheme } from '../../../shared/theme/theme';

const fieldErrorKeys: Readonly<Record<AuthFieldError, string>> = {
  invalid_email: 'email',
  invalid_code: 'code',
  password_too_short: 'passwordMinimum',
  password_too_long: 'passwordMaximum',
  password_requires_letter: 'passwordLettersDigits',
  password_requires_digit: 'passwordLettersDigits',
};

function useAuthView() {
  const runtime = useOptionalAuthRuntime();
  if (runtime === null || runtime.controller === null) return null;
  return {
    controller: runtime.controller,
    snapshot: runtime.snapshot,
  };
}

function ScreenFrame({
  title,
  description,
  children,
  protectScreen = false,
}: React.PropsWithChildren<{
  readonly title: string;
  readonly description?: string;
  readonly protectScreen?: boolean;
}>) {
  const { theme } = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      {protectScreen && <ScreenCaptureGuard />}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: 'center',
            padding: theme.spacing.lg,
            gap: theme.spacing.md,
          }}
        >
          <Text
            accessibilityRole="header"
            style={{ color: theme.colors.text, fontSize: theme.typography.heading }}
          >
            {title}
          </Text>
          {description !== undefined && (
            <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.body }}>
              {description}
            </Text>
          )}
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ActionButton({
  label,
  onPress,
  disabled = false,
  secondary = false,
  testID,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly secondary?: boolean;
  readonly testID?: string;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: 48,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: theme.spacing.md,
        borderRadius: theme.radius.md,
        borderWidth: secondary ? 1 : 0,
        borderColor: theme.colors.border,
        backgroundColor: secondary ? theme.colors.surface : theme.colors.primary,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <Text
        style={{
          color: secondary ? theme.colors.text : theme.colors.onPrimary,
          fontSize: theme.typography.body,
          textAlign: 'center',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function FormField({
  label,
  value,
  onChangeText,
  error,
  hint,
  keyboardType,
  autoComplete,
  autoCapitalize = 'none',
  secureTextEntry = false,
  maxLength,
  testID,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly error?: string | null;
  readonly hint?: string;
  readonly keyboardType?: KeyboardTypeOptions;
  readonly autoComplete?: TextInputProps['autoComplete'];
  readonly autoCapitalize?: TextInputProps['autoCapitalize'];
  readonly secureTextEntry?: boolean;
  readonly maxLength?: number;
  readonly testID?: string;
}) {
  const { theme } = useTheme();
  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Text style={{ color: theme.colors.text, fontSize: theme.typography.body }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        autoComplete={autoComplete}
        autoCapitalize={autoCapitalize}
        secureTextEntry={secureTextEntry}
        maxLength={maxLength}
        style={{
          minHeight: 48,
          paddingHorizontal: theme.spacing.md,
          color: theme.colors.text,
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: theme.radius.md,
          fontSize: theme.typography.body,
        }}
      />
      {hint !== undefined && (
        <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.body }}>
          {hint}
        </Text>
      )}
      {error !== undefined && error !== null && (
        <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.danger }}>
          {error}
        </Text>
      )}
    </View>
  );
}

function StatusText({ children, testID }: React.PropsWithChildren<{ readonly testID?: string }>) {
  const { theme } = useTheme();
  return (
    <Text
      testID={testID}
      accessibilityLiveRegion="polite"
      style={{ color: theme.colors.mutedText }}
    >
      {children}
    </Text>
  );
}

function AuthErrorText({ error }: { readonly error: AuthSnapshot['error'] }) {
  const { theme } = useTheme();
  if (error === null) return null;
  return (
    <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.danger }}>
      {translateMobile(`errors.${error}`)}
    </Text>
  );
}

function FieldErrorText({ error }: { readonly error: AuthFieldError | null }) {
  const { t } = useTranslation('auth');
  const { theme } = useTheme();
  if (error === null) return null;
  return (
    <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.danger }}>
      {t(`fieldErrors.${fieldErrorKeys[error]}`)}
    </Text>
  );
}

function RuntimeUnavailableScreen() {
  const { t } = useTranslation('auth');
  return <ScreenFrame title={t('authUnavailable')} />;
}

function useTickWhileResendIsPending(controller: AuthController | null, seconds: number) {
  useEffect(() => {
    if (controller === null || seconds <= 0) return;
    const interval = setInterval(() => controller.tick(), 1000);
    return () => clearInterval(interval);
  }, [controller, seconds]);
}

function routeAfterSignIn(router: ReturnType<typeof useRouter>, snapshot: AuthSnapshot): void {
  router.replace(snapshot.needsConsent.length > 0 ? '/(gates)/terms' : '/(app)/(tabs)');
}

export function WelcomeScreen() {
  const router = useRouter();
  const { t } = useTranslation('auth');
  const otpEnabled = product.auth.methods.includes('email_otp');
  const passwordEnabled = product.auth.methods.includes('email_password');
  return (
    <ScreenFrame title={t('welcomeTitle')} description={t('welcomeDescription')}>
      {otpEnabled && (
        <ActionButton
          label={t('emailCodeMethod')}
          testID="auth.welcome.email-code"
          onPress={() => router.push('/(auth)/email')}
        />
      )}
      {passwordEnabled && (
        <ActionButton
          label={t('emailPasswordMethod')}
          testID="auth.welcome.password"
          secondary={otpEnabled}
          onPress={() => router.push('/(auth)/password')}
        />
      )}
      {passwordEnabled && (
        <ActionButton
          label={t('createAccount')}
          testID="auth.welcome.sign-up"
          secondary
          onPress={() => router.push('/(auth)/sign-up')}
        />
      )}
    </ScreenFrame>
  );
}

export function EmailCodeStartScreen() {
  const router = useRouter();
  const { t } = useTranslation('auth');
  const { controller, snapshot } = useAuthView() ?? {};
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<AuthFieldError | null>(null);
  if (controller === undefined || snapshot === undefined) return <RuntimeUnavailableScreen />;

  const begin = async () => {
    const checked = normalizeEmail(email);
    if (!checked.ok) {
      setFieldError(checked.error);
      return;
    }
    setFieldError(null);
    const result = await controller.beginSignInWithCode(checked.value);
    if (result.ok) router.push('/(auth)/code');
  };

  return (
    <ScreenFrame title={t('emailScreenTitle')} description={t('emailHint')}>
      <FormField
        label={t('emailLabel')}
        testID="auth.email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoComplete="email"
        maxLength={254}
      />
      <AuthErrorText error={snapshot.error} />
      <ActionButton
        label={t('sendCode')}
        testID="auth.submit"
        disabled={snapshot.isBusy}
        onPress={() => void begin()}
      />
      {product.auth.methods.includes('email_password') && (
        <ActionButton
          label={t('emailPasswordMethod')}
          testID="auth.password-link"
          secondary
          onPress={() => router.push('/(auth)/password')}
        />
      )}
      {product.auth.methods.includes('email_password') && (
        <ActionButton
          label={t('createAccount')}
          testID="auth.sign-up-link"
          secondary
          onPress={() => router.push('/(auth)/sign-up')}
        />
      )}
      <FieldErrorText error={fieldError} />
    </ScreenFrame>
  );
}

export function PasswordSignInScreen() {
  const router = useRouter();
  const { t } = useTranslation('auth');
  const runtime = useAuthView();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldError, setFieldError] = useState<AuthFieldError | null>(null);
  if (runtime === null) return <RuntimeUnavailableScreen />;

  const submit = async () => {
    const checkedEmail = normalizeEmail(email);
    if (!checkedEmail.ok) {
      setFieldError(checkedEmail.error);
      return;
    }
    const checkedPassword = validatePassword(password);
    if (!checkedPassword.ok) {
      setFieldError(checkedPassword.error);
      return;
    }
    setFieldError(null);
    const result = await runtime.controller.signInWithPassword(
      checkedEmail.value,
      checkedPassword.value,
    );
    if (result.ok) routeAfterSignIn(router, runtime.controller.getSnapshot());
  };

  return (
    <ScreenFrame title={t('passwordScreenTitle')}>
      <FormField
        label={t('emailLabel')}
        testID="auth.email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoComplete="email"
        maxLength={254}
      />
      <FormField
        label={t('passwordLabel')}
        testID="auth.password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        hint={t('passwordHint')}
      />
      <FieldErrorText error={fieldError} />
      <AuthErrorText error={runtime.snapshot.error} />
      <ActionButton
        label={t('signIn')}
        testID="auth.submit"
        disabled={runtime.snapshot.isBusy}
        onPress={() => void submit()}
      />
      <ActionButton
        label={t('forgotPassword')}
        testID="auth.forgot-password"
        secondary
        onPress={() => router.push('/(auth)/forgot-password')}
      />
      {product.auth.methods.includes('email_otp') && (
        <ActionButton
          label={t('useEmailCode')}
          testID="auth.email-code-link"
          secondary
          onPress={() => router.push('/(auth)/email')}
        />
      )}
    </ScreenFrame>
  );
}

export function SignUpScreen() {
  const router = useRouter();
  const { t } = useTranslation('auth');
  const runtime = useAuthView();
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<AuthFieldError | null>(null);
  const [submitted, setSubmitted] = useState(false);
  if (runtime === null) return <RuntimeUnavailableScreen />;

  const begin = async () => {
    const checked = normalizeEmail(email);
    if (!checked.ok) {
      setFieldError(checked.error);
      return;
    }
    setFieldError(null);
    const result = await runtime.controller.beginSignUp(checked.value);
    if (result.ok) {
      setSubmitted(true);
      router.push('/(auth)/code');
    }
  };

  return (
    <ScreenFrame title={t('signUpTitle')} description={t('emailHint')}>
      <FormField
        label={t('emailLabel')}
        testID="auth.email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoComplete="email"
        maxLength={254}
      />
      <FieldErrorText error={fieldError} />
      <AuthErrorText error={runtime.snapshot.error} />
      <ActionButton
        label={t('sendCode')}
        testID="auth.submit"
        disabled={runtime.snapshot.isBusy}
        onPress={() => void begin()}
      />
      {submitted && <StatusText>{t('emailInstructionsSent')}</StatusText>}
    </ScreenFrame>
  );
}

export function ForgotPasswordScreen() {
  const router = useRouter();
  const { t } = useTranslation('auth');
  const runtime = useAuthView();
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<AuthFieldError | null>(null);
  const [submitted, setSubmitted] = useState(false);
  if (runtime === null) return <RuntimeUnavailableScreen />;

  const begin = async () => {
    const checked = normalizeEmail(email);
    if (!checked.ok) {
      setFieldError(checked.error);
      return;
    }
    setFieldError(null);
    const result = await runtime.controller.beginPasswordRecovery(checked.value);
    if (result.ok) {
      setSubmitted(true);
      router.push('/(auth)/code');
    }
  };

  return (
    <ScreenFrame title={t('forgotPasswordTitle')} description={t('emailHint')}>
      <FormField
        label={t('emailLabel')}
        testID="auth.email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoComplete="email"
        maxLength={254}
      />
      <FieldErrorText error={fieldError} />
      <AuthErrorText error={runtime.snapshot.error} />
      <ActionButton
        label={t('sendCode')}
        testID="auth.submit"
        disabled={runtime.snapshot.isBusy}
        onPress={() => void begin()}
      />
      {submitted && <StatusText>{t('emailInstructionsSent')}</StatusText>}
    </ScreenFrame>
  );
}

export function EmailCodeScreen({
  protectScreen = true,
}: { readonly protectScreen?: boolean } = {}) {
  const router = useRouter();
  const { t } = useTranslation('auth');
  const runtime = useAuthView();
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<AuthFieldError | null>(null);
  useTickWhileResendIsPending(
    runtime?.controller ?? null,
    runtime?.snapshot.resendSecondsRemaining ?? 0,
  );
  if (runtime === null) return <RuntimeUnavailableScreen />;
  const flow = runtime.snapshot.flow;

  if (flow.kind !== 'email_code' || flow.stage !== 'code') {
    return (
      <ScreenFrame title={t('codeScreenTitle')} protectScreen={protectScreen}>
        <StatusText>{t('authUnavailable')}</StatusText>
        <ActionButton label={t('useEmailCode')} onPress={() => router.replace('/(auth)/email')} />
      </ScreenFrame>
    );
  }

  const submit = async () => {
    const checked = validateOtpCode(code);
    if (!checked.ok) {
      setFieldError(checked.error);
      return;
    }
    setFieldError(null);
    const result = await runtime.controller.verifyCode(checked.value);
    const next = runtime.controller.getSnapshot();
    if (next.flow.kind === 'password_setup') {
      router.replace('/(auth)/new-password');
      return;
    }
    if (!result.ok) return;
    routeAfterSignIn(router, next);
  };

  return (
    <ScreenFrame
      title={t('codeScreenTitle')}
      description={`${t('codeHint')} ${t('codeExpiresIn')}`}
      protectScreen={protectScreen}
    >
      <FormField
        label={t('codeLabel')}
        testID="auth.otp"
        value={code}
        onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 10))}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        maxLength={10}
      />
      <FieldErrorText error={fieldError} />
      <AuthErrorText error={runtime.snapshot.error} />
      <ActionButton
        label={t('verifyCode')}
        testID="auth.submit"
        disabled={runtime.snapshot.isBusy}
        onPress={() => void submit()}
      />
      <ActionButton
        label={t('resendCode')}
        testID="auth.resend"
        secondary
        disabled={runtime.snapshot.isBusy || runtime.snapshot.resendSecondsRemaining > 0}
        onPress={() => void runtime.controller.resendCode()}
      />
      {runtime.snapshot.resendSecondsRemaining > 0 && (
        <StatusText>
          {t('resendIn', { seconds: runtime.snapshot.resendSecondsRemaining })}
        </StatusText>
      )}
    </ScreenFrame>
  );
}

export function PasswordSetupScreen({
  protectScreen = true,
}: { readonly protectScreen?: boolean } = {}) {
  const router = useRouter();
  const { t } = useTranslation('auth');
  const runtime = useAuthView();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [fieldError, setFieldError] = useState<AuthFieldError | null>(null);
  const [passwordMismatch, setPasswordMismatch] = useState(false);
  if (runtime === null) return <RuntimeUnavailableScreen />;
  const setupFlow = runtime.snapshot.flow;
  if (setupFlow.kind !== 'password_setup') {
    return (
      <ScreenFrame title={t('newPasswordTitle')} protectScreen={protectScreen}>
        <StatusText>{t('authUnavailable')}</StatusText>
        <ActionButton label={t('useEmailCode')} onPress={() => router.replace('/(auth)/email')} />
      </ScreenFrame>
    );
  }

  const submit = async () => {
    const checked = validatePassword(password);
    if (!checked.ok) {
      setFieldError(checked.error);
      setPasswordMismatch(false);
      return;
    }
    if (password !== confirmation) {
      setFieldError(null);
      setPasswordMismatch(true);
      return;
    }
    setFieldError(null);
    setPasswordMismatch(false);
    const result = await runtime.controller.setPassword(checked.value);
    if (result.ok) routeAfterSignIn(router, runtime.controller.getSnapshot());
  };

  return (
    <ScreenFrame
      title={t('newPasswordTitle')}
      description={t('passwordHint')}
      protectScreen={protectScreen}
    >
      <FormField
        label={t('newPasswordLabel')}
        testID="auth.new-password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="new-password"
        error={null}
      />
      <FormField
        label={t('confirmPasswordLabel')}
        testID="auth.confirm-password"
        value={confirmation}
        onChangeText={setConfirmation}
        secureTextEntry
        autoComplete="new-password"
        error={passwordMismatch ? t('fieldErrors.passwordMismatch') : null}
      />
      <FieldErrorText error={fieldError} />
      <AuthErrorText error={runtime.snapshot.error} />
      <ActionButton
        label={t('savePassword')}
        testID="auth.submit"
        disabled={runtime.snapshot.isBusy}
        onPress={() => void submit()}
      />
    </ScreenFrame>
  );
}

export function ReauthenticationScreen({
  protectScreen = true,
}: {
  readonly protectScreen?: boolean;
} = {}) {
  const router = useRouter();
  const { t } = useTranslation('auth');
  const runtime = useAuthView();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<AuthFieldError | null>(null);
  useTickWhileResendIsPending(
    runtime?.controller ?? null,
    runtime?.snapshot.resendSecondsRemaining ?? 0,
  );
  if (runtime === null) return <RuntimeUnavailableScreen />;
  const method: StepUpMethod | null = runtime.snapshot.authMethod;
  const flow = runtime.snapshot.flow;
  const stepUpCode = flow.kind === 'step_up' && flow.stage === 'code';

  const cancel = () => {
    runtime.controller.resetFlow();
    if (router.canGoBack()) router.back();
    else router.replace('/(app)/(tabs)');
  };
  const submitCode = async () => {
    const checked = validateOtpCode(code);
    if (!checked.ok) {
      setFieldError(checked.error);
      return;
    }
    setFieldError(null);
    const result = await runtime.controller.verifyStepUpCode(checked.value);
    if (result.ok) cancel();
  };
  const begin = async () => {
    const email = runtime.snapshot.me?.email;
    if (email === null || email === undefined || method === null) return;
    if (method === 'email_otp') {
      const result = await runtime.controller.beginStepUp(method, email);
      if (!result.ok) return;
      return;
    }
    const checkedPassword = validatePassword(password);
    if (!checkedPassword.ok) {
      setFieldError(checkedPassword.error);
      return;
    }
    setFieldError(null);
    const result = await runtime.controller.beginStepUp(method, email, checkedPassword.value);
    if (result.ok) cancel();
  };

  return (
    <ScreenFrame
      title={t('reauthTitle')}
      description={t('reauthDescription')}
      protectScreen={protectScreen}
    >
      {stepUpCode ? (
        <>
          <FormField
            label={t('codeLabel')}
            testID="auth.reauth.code"
            value={code}
            onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 10))}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            maxLength={10}
            hint={`${t('codeHint')} ${t('codeExpiresIn')}`}
          />
          <FieldErrorText error={fieldError} />
          <ActionButton
            label={t('verifyCode')}
            testID="auth.submit"
            disabled={runtime.snapshot.isBusy}
            onPress={() => void submitCode()}
          />
          <ActionButton
            label={t('resendCode')}
            testID="auth.resend"
            secondary
            disabled={runtime.snapshot.isBusy || runtime.snapshot.resendSecondsRemaining > 0}
            onPress={() => void runtime.controller.resendCode()}
          />
          {runtime.snapshot.resendSecondsRemaining > 0 && (
            <StatusText>
              {t('resendIn', { seconds: runtime.snapshot.resendSecondsRemaining })}
            </StatusText>
          )}
        </>
      ) : (
        <>
          {method === 'email_password' ? (
            <FormField
              label={t('passwordLabel')}
              testID="auth.password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="current-password"
              hint={t('passwordHint')}
            />
          ) : method === 'email_otp' ? (
            <StatusText>{t('emailHint')}</StatusText>
          ) : (
            <StatusText>{t('sameAccountRequired')}</StatusText>
          )}
          <FieldErrorText error={fieldError} />
          <ActionButton
            label={method === 'email_otp' ? t('sendCode') : t('signIn')}
            testID="auth.submit"
            disabled={runtime.snapshot.isBusy || method === null}
            onPress={() => void begin()}
          />
        </>
      )}
      <AuthErrorText error={runtime.snapshot.error} />
      <ActionButton label={t('cancel')} secondary onPress={cancel} />
    </ScreenFrame>
  );
}

export function ChangeEmailScreen() {
  const router = useRouter();
  const { t } = useTranslation('auth');
  const { t: tSettings } = useTranslation('settings');
  const runtime = useAuthView();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<AuthFieldError | null>(null);
  const [completed, setCompleted] = useState(false);
  const activeFlow = runtime?.snapshot.flow;
  useTickWhileResendIsPending(
    runtime?.controller ?? null,
    activeFlow?.kind === 'email_change' ? (runtime?.snapshot.resendSecondsRemaining ?? 0) : 0,
  );
  useEffect(() => {
    setCode('');
  }, [activeFlow?.kind, activeFlow?.kind === 'email_change' ? activeFlow.stage : null]);
  if (runtime === null) return <RuntimeUnavailableScreen />;
  const flow = runtime.snapshot.flow;
  const isChanging = flow.kind === 'email_change';

  const start = async () => {
    if (!runtime.controller.hasRecentAuthentication()) {
      router.push('/(app)/reauth');
      return;
    }
    const checked = normalizeEmail(email);
    if (!checked.ok) {
      setFieldError(checked.error);
      return;
    }
    setFieldError(null);
    const result = await runtime.controller.beginEmailChange(checked.value);
    if (result.ok) setCompleted(false);
  };
  const verify = async () => {
    const checked = validateOtpCode(code);
    if (!checked.ok) {
      setFieldError(checked.error);
      return;
    }
    setFieldError(null);
    if (flow.kind !== 'email_change') return;
    const result = await runtime.controller.verifyEmailChangeCode(
      flow.stage === 'verify_old' ? 'old' : 'new',
      checked.value,
    );
    if (result.ok && runtime.controller.getSnapshot().flow.kind === 'idle') setCompleted(true);
  };

  return (
    <ScreenFrame
      title={tSettings('changeEmail')}
      description={isChanging ? t('emailChangeInstructions') : t('reauthDescription')}
      protectScreen
    >
      {isChanging && flow.kind === 'email_change' ? (
        <>
          <StatusText>
            {flow.stage === 'verify_old' ? t('currentEmailLabel') : t('newEmailLabel')}
          </StatusText>
          <FormField
            label={t('codeLabel')}
            testID="auth.change-email.code"
            value={code}
            onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 10))}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            maxLength={10}
            hint={`${t('codeHint')} ${t('codeExpiresIn')}`}
          />
          <FieldErrorText error={fieldError} />
          <AuthErrorText error={runtime.snapshot.error} />
          <ActionButton
            label={t('verifyCode')}
            testID="auth.submit"
            disabled={runtime.snapshot.isBusy}
            onPress={() => void verify()}
          />
          <ActionButton
            label={t('resendCode')}
            testID="auth.resend"
            secondary
            disabled={runtime.snapshot.isBusy || runtime.snapshot.resendSecondsRemaining > 0}
            onPress={() =>
              void runtime.controller.resendCode(flow.stage === 'verify_old' ? 'old' : 'new')
            }
          />
          {runtime.snapshot.resendSecondsRemaining > 0 && (
            <StatusText>
              {t('resendIn', { seconds: runtime.snapshot.resendSecondsRemaining })}
            </StatusText>
          )}
        </>
      ) : (
        <>
          <FormField
            label={t('newEmailLabel')}
            testID="auth.change-email.address"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoComplete="email"
            maxLength={254}
          />
          <FieldErrorText error={fieldError} />
          <AuthErrorText error={runtime.snapshot.error} />
          <ActionButton
            label={tSettings('changeEmail')}
            testID="auth.submit"
            disabled={runtime.snapshot.isBusy}
            onPress={() => void start()}
          />
          {completed && <StatusText>{t('emailChangeComplete')}</StatusText>}
        </>
      )}
    </ScreenFrame>
  );
}

export function ChangePasswordScreen() {
  const router = useRouter();
  const { t } = useTranslation('auth');
  const { t: tSettings } = useTranslation('settings');
  const runtime = useAuthView();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [fieldError, setFieldError] = useState<AuthFieldError | null>(null);
  const [passwordMismatch, setPasswordMismatch] = useState(false);
  const [completed, setCompleted] = useState(false);
  const activeFlow = runtime?.snapshot.flow;
  useTickWhileResendIsPending(
    runtime?.controller ?? null,
    activeFlow?.kind === 'password_change' && activeFlow.stage === 'code'
      ? (runtime?.snapshot.resendSecondsRemaining ?? 0)
      : 0,
  );
  if (runtime === null) return <RuntimeUnavailableScreen />;
  const flow = runtime.snapshot.flow;
  const changing = flow.kind === 'password_change';
  const codeStage = changing && flow.stage === 'code';

  const start = async () => {
    if (!runtime.controller.hasRecentAuthentication()) {
      router.push('/(app)/reauth');
      return;
    }
    const result = await runtime.controller.beginPasswordChange();
    if (result.ok) setCompleted(false);
  };
  const stageCode = async () => {
    const checked = validateOtpCode(code);
    if (!checked.ok) {
      setFieldError(checked.error);
      return;
    }
    setFieldError(null);
    await runtime.controller.stagePasswordChangeCode(checked.value);
  };
  const save = async () => {
    const checked = validatePassword(password);
    if (!checked.ok) {
      setFieldError(checked.error);
      setPasswordMismatch(false);
      return;
    }
    if (password !== confirmation) {
      setFieldError(null);
      setPasswordMismatch(true);
      return;
    }
    setFieldError(null);
    setPasswordMismatch(false);
    const result = await runtime.controller.changePassword(checked.value);
    if (result.ok) setCompleted(true);
  };

  return (
    <ScreenFrame
      title={tSettings('changePassword')}
      description={t('passwordChangeInstructions')}
      protectScreen
    >
      {!changing ? (
        <ActionButton
          label={tSettings('changePassword')}
          testID="auth.change-password.start"
          disabled={runtime.snapshot.isBusy}
          onPress={() => void start()}
        />
      ) : codeStage ? (
        <>
          <FormField
            label={t('codeLabel')}
            testID="auth.change-password.code"
            value={code}
            onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 10))}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            maxLength={10}
            hint={`${t('codeHint')} ${t('codeExpiresIn')}`}
          />
          <FieldErrorText error={fieldError} />
          <AuthErrorText error={runtime.snapshot.error} />
          <ActionButton
            label={t('continue')}
            testID="auth.stage-code"
            disabled={runtime.snapshot.isBusy}
            onPress={() => void stageCode()}
          />
          <ActionButton
            label={t('resendCode')}
            testID="auth.resend"
            secondary
            disabled={runtime.snapshot.isBusy || runtime.snapshot.resendSecondsRemaining > 0}
            onPress={() => void runtime.controller.resendCode()}
          />
          {runtime.snapshot.resendSecondsRemaining > 0 && (
            <StatusText>
              {t('resendIn', { seconds: runtime.snapshot.resendSecondsRemaining })}
            </StatusText>
          )}
        </>
      ) : (
        <>
          <FormField
            label={t('newPasswordLabel')}
            testID="auth.new-password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="new-password"
            hint={t('passwordHint')}
          />
          <FormField
            label={t('confirmPasswordLabel')}
            testID="auth.confirm-password"
            value={confirmation}
            onChangeText={setConfirmation}
            secureTextEntry
            autoComplete="new-password"
            error={passwordMismatch ? t('fieldErrors.passwordMismatch') : null}
          />
          <FieldErrorText error={fieldError} />
          <AuthErrorText error={runtime.snapshot.error} />
          <ActionButton
            label={t('savePassword')}
            testID="auth.submit"
            disabled={runtime.snapshot.isBusy}
            onPress={() => void save()}
          />
        </>
      )}
      {completed && <StatusText testID="auth.password-updated">{t('passwordSaved')}</StatusText>}
    </ScreenFrame>
  );
}

function ConsentCheckbox({
  label,
  checked,
  onPress,
  testID,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onPress: () => void;
  readonly testID?: string;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      testID={testID}
      onPress={onPress}
      style={{
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        padding: theme.spacing.sm,
        gap: theme.spacing.sm,
      }}
    >
      <View
        style={{
          width: 24,
          height: 24,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 2,
          borderColor: checked ? theme.colors.primary : theme.colors.border,
          borderRadius: theme.radius.sm,
          backgroundColor: checked ? theme.colors.primary : theme.colors.background,
        }}
      >
        {checked && (
          <Text style={{ color: theme.colors.onPrimary, fontSize: theme.typography.body }}>✓</Text>
        )}
      </View>
      <Text style={{ flex: 1, color: theme.colors.text, fontSize: theme.typography.body }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function TermsConsentScreen() {
  const router = useRouter();
  const { t } = useTranslation('privacy');
  const { t: tCommon } = useTranslation('common');
  const runtime = useAuthView();
  const appConfig = useAppConfig();
  const [termsChecked, setTermsChecked] = useState(false);
  const [privacyChecked, setPrivacyChecked] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  if (runtime === null) return <RuntimeUnavailableScreen />;

  const openDocument = async (url: string) => {
    const opened = await openExternalUrl(url);
    if (!opened) setErrorKey('linkUnavailable');
  };
  const accept = async () => {
    if (appConfig.offline) {
      setErrorKey('consentOffline');
      return;
    }
    if (!termsChecked || !privacyChecked) {
      setErrorKey('consentRequired');
      return;
    }
    setErrorKey(null);
    const termsResult = await runtime.controller.acceptConsent({
      document: 'terms',
      version: appConfig.config.legal.termsVersion,
    });
    if (!termsResult.ok) {
      setErrorKey('consentSaveFailed');
      return;
    }
    const privacyResult = await runtime.controller.acceptConsent({
      document: 'privacy',
      version: appConfig.config.legal.privacyVersion,
    });
    if (!privacyResult.ok) {
      setErrorKey('consentPartialFailure');
      return;
    }
    const refreshed = await runtime.controller.refreshMe();
    if (!refreshed.ok) {
      setErrorKey('consentRefreshFailure');
      return;
    }
    router.replace('/(app)/(tabs)');
  };
  const retryProfile = async () => {
    if (appConfig.offline) return;
    setErrorKey(null);
    const refreshed = await runtime.controller.refreshMe();
    if (!refreshed.ok) {
      setErrorKey('consentRefreshFailure');
      return;
    }
    if (refreshed.value.consents.needsAcceptance.length === 0) {
      router.replace('/(app)/(tabs)');
    }
  };

  return (
    <ScreenFrame title={t('termsTitle')} description={t('termsDescription')}>
      {appConfig.offline && <StatusText>{tCommon('offlineHint')}</StatusText>}
      <ActionButton
        label={tCommon('retry')}
        testID="privacy.retry-profile"
        secondary
        disabled={appConfig.offline || runtime.snapshot.isBusy}
        onPress={() => void retryProfile()}
      />
      <ActionButton
        label={t('openTerms')}
        testID="privacy.open-terms"
        secondary
        onPress={() => void openDocument(appConfig.config.legal.termsUrl)}
      />
      <ConsentCheckbox
        label={t('termsConsent', { version: appConfig.config.legal.termsVersion })}
        testID="privacy.checkbox.terms"
        checked={termsChecked}
        onPress={() => setTermsChecked((current) => !current)}
      />
      <ActionButton
        label={t('openPrivacy')}
        testID="privacy.open-notice"
        secondary
        onPress={() => void openDocument(appConfig.config.legal.privacyUrl)}
      />
      <ConsentCheckbox
        label={t('privacyConsent', { version: appConfig.config.legal.privacyVersion })}
        testID="privacy.checkbox.notice"
        checked={privacyChecked}
        onPress={() => setPrivacyChecked((current) => !current)}
      />
      {errorKey !== null && (
        <StatusText>{t(errorKey, { interpolation: { escapeValue: true } })}</StatusText>
      )}
      <AuthErrorText error={runtime.snapshot.error} />
      <ActionButton
        label={t('acceptDocuments')}
        testID="privacy.accept"
        disabled={runtime.snapshot.isBusy || appConfig.offline}
        onPress={() => void accept()}
      />
    </ScreenFrame>
  );
}

export function AccountProfileScreen() {
  const { t } = useTranslation('settings');
  const runtime = useAuthView();
  const [displayName, setDisplayName] = useState('');
  const [statusKey, setStatusKey] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!initialized && runtime?.snapshot.me !== null && runtime?.snapshot.me !== undefined) {
      setDisplayName(runtime.snapshot.me.displayName ?? '');
      setInitialized(true);
    }
  }, [initialized, runtime?.snapshot.me]);

  if (runtime === null) return <RuntimeUnavailableScreen />;

  const save = async () => {
    const normalized = displayName.trim();
    if (normalized.length < 1 || normalized.length > 80) {
      setStatusKey('profileError');
      return;
    }
    const result = await runtime.controller.updateProfile({ displayName: normalized });
    setStatusKey(result.ok ? 'profileSaved' : 'profileError');
  };

  return (
    <ScreenFrame title={t('account')} description={t('accountDescription')}>
      {runtime.snapshot.me?.email !== null && runtime.snapshot.me?.email !== undefined && (
        <StatusText>{runtime.snapshot.me.email}</StatusText>
      )}
      <FormField
        label={t('displayName')}
        testID="settings.display-name"
        value={displayName}
        onChangeText={setDisplayName}
        autoCapitalize="words"
        maxLength={80}
      />
      {statusKey !== null && <StatusText>{t(statusKey)}</StatusText>}
      <AuthErrorText error={runtime.snapshot.error} />
      <ActionButton
        label={t('saveProfile')}
        testID="settings.save-profile"
        disabled={runtime.snapshot.isBusy}
        onPress={() => void save()}
      />
      <ActionButton
        label={t('changeEmail')}
        testID="settings.change-email"
        secondary
        onPress={() => router.push('/(app)/settings/change-email')}
      />
      <ActionButton
        label={t('changePassword')}
        testID="settings.change-password"
        secondary
        onPress={() => router.push('/(app)/settings/change-password')}
      />
    </ScreenFrame>
  );
}
