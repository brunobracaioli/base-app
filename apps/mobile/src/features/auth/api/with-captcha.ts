import type { CaptchaAction, CaptchaProvider, CaptchaToken } from '../../../extensions/types';

function isFailedResult(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
}

export async function withCaptcha<T>(
  provider: CaptchaProvider | null,
  action: CaptchaAction,
  call: (token: string | undefined) => Promise<T>,
): Promise<T> {
  if (provider === null) {
    return call(undefined);
  }

  const captchaToken: CaptchaToken = await provider.getToken(action);
  let tokenWasConsumed = false;
  try {
    const result = await call(captchaToken.token);
    tokenWasConsumed = !isFailedResult(result);
    return result;
  } finally {
    if (!tokenWasConsumed) {
      provider.release(captchaToken);
    }
  }
}
