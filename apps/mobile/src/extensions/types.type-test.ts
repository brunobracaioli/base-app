import type { AuthMethodProps, BootContext, SessionSummary } from './types';
import { extensionAuth } from './api';

const summary: SessionSummary = {
  userId: '5fa6acc4-75aa-4e60-8129-3db379c1c804',
  isAnonymous: false,
};
void summary;

declare const authProps: AuthMethodProps;
// @ts-expect-error Extensions must not receive a session or token through auth props.
void authProps.accessToken;
// @ts-expect-error Extensions receive a sanitized session summary only.
void authProps.session;

declare const bootContext: BootContext;
// @ts-expect-error Boot gates receive a summary and never credentials.
void bootContext.accessToken;
// @ts-expect-error Boot context has no raw auth session.
void bootContext.session?.accessToken;

void extensionAuth.linkIdentity({ provider: 'oidc' });
// @ts-expect-error Linking identity accepts a provider name, not an identity token.
void extensionAuth.linkIdentity({ provider: 'oidc', token: 'identity-token' });
void extensionAuth.unlinkIdentity({ identityId: 'identity-1' });
// @ts-expect-error Unlinking requires the exact identity id.
void extensionAuth.unlinkIdentity({ provider: 'oidc' });
void extensionAuth.verifyEmailChangeOtp({ email: 'user@example.test', token: 'otp-token' });
// @ts-expect-error OTP verification uses the token field, not a code field.
void extensionAuth.verifyEmailChangeOtp({ email: 'user@example.test', code: '123456' });
void extensionAuth.withPreviousSession(async (previousAccessToken) => previousAccessToken.length);
