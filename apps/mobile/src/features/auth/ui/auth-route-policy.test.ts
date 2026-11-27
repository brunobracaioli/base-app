import { resolveAuthRoutePolicy } from './auth-route-policy';

describe('auth route policy', () => {
  it('allows email-code login routes when the password method is disabled', () => {
    expect(resolveAuthRoutePolicy(['email_otp'])).toEqual({
      welcome: true,
      email: true,
      code: true,
      password: false,
      signUp: false,
      forgotPassword: false,
      newPassword: false,
    });
  });

  it('allows password verification-code routes when email-code login is disabled', () => {
    expect(resolveAuthRoutePolicy(['email_password'])).toEqual({
      welcome: true,
      email: false,
      code: true,
      password: true,
      signUp: true,
      forgotPassword: true,
      newPassword: true,
    });
  });
});
