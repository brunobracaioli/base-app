import type { AuthMethodProps, BootContext, SessionSummary } from './types';

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
