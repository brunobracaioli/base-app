import type { UserAuthContext } from '../authorization/types';

const profileLocaleHints = new WeakMap<UserAuthContext, string>();

export function getProfileLocaleHint(context: UserAuthContext): string | undefined {
  return profileLocaleHints.get(context);
}

export function storeProfileLocaleHint(context: UserAuthContext, locale: string | undefined): void {
  if (locale === undefined) return;
  profileLocaleHints.set(context, locale);
}
