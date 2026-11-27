import product from '@base-app/config/product.config';

export type AuthRoutePolicy = {
  readonly welcome: boolean;
  readonly email: boolean;
  readonly code: boolean;
  readonly password: boolean;
  readonly signUp: boolean;
  readonly forgotPassword: boolean;
  readonly newPassword: boolean;
};

export function resolveAuthRoutePolicy(
  methods: readonly string[] = product.auth.methods,
): AuthRoutePolicy {
  const hasEmailOtp = methods.includes('email_otp');
  const hasEmailPassword = methods.includes('email_password');
  const hasEmailAuth = hasEmailOtp || hasEmailPassword;

  return {
    welcome: hasEmailAuth,
    email: hasEmailOtp,
    code: hasEmailAuth,
    password: hasEmailPassword,
    signUp: hasEmailPassword,
    forgotPassword: hasEmailPassword,
    newPassword: hasEmailPassword,
  };
}
