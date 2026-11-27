import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { AuthStorage } from './encrypted-storage';

export const AUTH_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_AUTH_RESPONSE_BYTES = 1_048_576;

export type AuthClientConfig = {
  readonly supabaseUrl: string;
  readonly publishableKey: string;
  readonly storage?: AuthStorage;
  readonly persistSession: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly onRequestController?: (controller: AbortController) => () => void;
};

class AuthResponseTooLargeError extends Error {}

function reactNativeBufferedText(response: Response): string | null {
  const candidate = response as unknown as { readonly _bodyText?: unknown };
  return typeof candidate._bodyText === 'string' ? candidate._bodyText : null;
}

function sanitizedBodyError(error: unknown): Error {
  return error instanceof AuthResponseTooLargeError
    ? new Error('Authentication response is too large.')
    : new Error('Authentication request failed.');
}

async function readJsonBody(response: Response, timeout: Promise<never>): Promise<unknown> {
  if (typeof response.text === 'function') {
    const bodyText = await Promise.race([response.text(), timeout]);
    if (new TextEncoder().encode(bodyText).byteLength > MAX_AUTH_RESPONSE_BYTES) {
      throw new AuthResponseTooLargeError();
    }
    try {
      return JSON.parse(bodyText) as unknown;
    } catch {
      throw new Error('Authentication response is invalid.');
    }
  }

  const parsed = await Promise.race([response.json(), timeout]);
  const serialized = JSON.stringify(parsed);
  if (
    serialized !== undefined &&
    new TextEncoder().encode(serialized).byteLength > MAX_AUTH_RESPONSE_BYTES
  ) {
    throw new AuthResponseTooLargeError();
  }
  return parsed;
}

function createTimedResponseProxy(
  response: Response,
  timeout: Promise<never>,
  finish: () => void,
): Response {
  return new Proxy(response, {
    get(target, property) {
      if (property === 'clone') {
        return () => createTimedResponseProxy(target.clone(), timeout, finish);
      }
      if (property === 'json') {
        return async () => {
          try {
            return await readJsonBody(target, timeout);
          } catch (error) {
            throw sanitizedBodyError(error);
          } finally {
            finish();
          }
        };
      }
      if (property === 'text') {
        return async () => {
          try {
            const bodyText = await Promise.race([target.text(), timeout]);
            if (new TextEncoder().encode(bodyText).byteLength > MAX_AUTH_RESPONSE_BYTES) {
              throw new AuthResponseTooLargeError();
            }
            return bodyText;
          } catch (error) {
            throw sanitizedBodyError(error);
          } finally {
            finish();
          }
        };
      }
      if (property === 'arrayBuffer') {
        return async () => {
          try {
            const bodyBytes = await Promise.race([target.arrayBuffer(), timeout]);
            if (bodyBytes.byteLength > MAX_AUTH_RESPONSE_BYTES)
              throw new AuthResponseTooLargeError();
            return bodyBytes;
          } catch (error) {
            throw sanitizedBodyError(error);
          } finally {
            finish();
          }
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function createTimedAuthFetch(
  baseFetch: typeof globalThis.fetch,
  onRequestController?: (controller: AbortController) => () => void,
  timeoutMs = AUTH_REQUEST_TIMEOUT_MS,
): typeof globalThis.fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const externalSignal = init?.signal;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unregister = onRequestController?.(controller) ?? (() => undefined);

    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromCaller);
      unregister();
    };

    const abortFromCaller = () => controller.abort();
    if (externalSignal?.aborted) {
      controller.abort();
    } else {
      externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
    }

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        finish();
        reject(new Error('Authentication request timed out.'));
      }, timeoutMs);
    });

    let response: Response;
    try {
      response = await Promise.race([
        baseFetch(input, { ...init, signal: controller.signal }),
        timeout,
      ]);
    } catch {
      finish();
      throw new Error('Authentication request failed.');
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_AUTH_RESPONSE_BYTES) {
      controller.abort();
      finish();
      throw new Error('Authentication response is too large.');
    }
    const bufferedText = reactNativeBufferedText(response);
    if (
      bufferedText !== null &&
      new TextEncoder().encode(bufferedText).byteLength > MAX_AUTH_RESPONSE_BYTES
    ) {
      controller.abort();
      finish();
      throw new Error('Authentication response is too large.');
    }
    if (response.status === 204 || init?.method?.toUpperCase() === 'HEAD') {
      finish();
      return response;
    }

    const body = response.body;
    if (body != null && typeof body.getReader === 'function') {
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      let responseTooLarge = false;
      try {
        while (true) {
          const next = await Promise.race([reader.read(), timeout]);
          if (next.done) break;
          byteLength += next.value.byteLength;
          if (byteLength > MAX_AUTH_RESPONSE_BYTES) {
            responseTooLarge = true;
            controller.abort();
            await reader.cancel().catch(() => undefined);
            finish();
            throw new AuthResponseTooLargeError();
          }
          chunks.push(next.value);
        }

        const bodyBytes = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
          bodyBytes.set(chunk, offset);
          offset += chunk.length;
        }
        finish();
        return new Response(bodyBytes, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        finish();
        throw sanitizedBodyError(
          responseTooLarge ? new AuthResponseTooLargeError() : new Error('Auth body read failed.'),
        );
      }
    }

    return createTimedResponseProxy(response, timeout, finish);
  };
}

export function getSupabaseStorageKey(supabaseUrl: string): string {
  const projectReference = new URL(supabaseUrl).hostname.split('.')[0];
  if (projectReference === undefined || projectReference.length === 0) {
    throw new Error('Supabase configuration is invalid.');
  }
  return `sb-${projectReference}-auth-token`;
}

export function createSupabaseClient(config: AuthClientConfig): SupabaseClient {
  const storageKey = getSupabaseStorageKey(config.supabaseUrl);
  const fetch = createTimedAuthFetch(config.fetch ?? globalThis.fetch, config.onRequestController);

  return createClient(config.supabaseUrl, config.publishableKey, {
    auth: {
      autoRefreshToken: config.persistSession,
      persistSession: config.persistSession,
      detectSessionInUrl: false,
      storageKey,
      ...(config.persistSession && config.storage !== undefined ? { storage: config.storage } : {}),
    },
    global: { fetch },
  });
}
