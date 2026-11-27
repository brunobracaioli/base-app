import type { AuthErrorKey } from '../../../extensions/types';

type AuthErrorReporter = (event: 'email_send_rate_limited') => void;

function readCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = error.code;
  return typeof code === 'string' ? code : null;
}

function readStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) return null;
  const status = error.status;
  return typeof status === 'number' ? status : null;
}

function readName(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('name' in error)) return null;
  return typeof error.name === 'string' ? error.name : null;
}

export function mapAuthError(error: unknown, report?: AuthErrorReporter): AuthErrorKey {
  const code = readCode(error);
  if (code === 'over_email_send_rate_limit') {
    try {
      report?.('email_send_rate_limited');
    } catch {
      // Reporting failures must not change the Auth result.
    }
    return 'auth.failed';
  }
  if (code === 'session_not_found' || code === 'session_missing') {
    return 'auth.session_missing';
  }
  if (
    code === 'session_expired' ||
    code === 'refresh_token_already_used' ||
    code === 'invalid_refresh_token' ||
    code === 'jwt_expired'
  ) {
    return 'auth.session_expired';
  }
  if (
    code === 'fetch_error' ||
    readName(error) === 'AuthRetryableFetchError' ||
    (readStatus(error) ?? 0) >= 500
  ) {
    return 'auth.unavailable';
  }
  return 'auth.failed';
}

export function isSdkFailure(value: unknown): value is { readonly error: unknown } {
  return typeof value === 'object' && value !== null && 'error' in value && value.error != null;
}
