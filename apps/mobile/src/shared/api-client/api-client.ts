import * as Crypto from 'expo-crypto';
import * as z from 'zod';
import {
  ProblemDetailsSchema,
  type EndpointContract,
  type ProblemDetails,
} from '@base-app/contracts';

export type ApiEndpoint<T> = Omit<
  Pick<EndpointContract, 'method' | 'path' | 'security' | 'successStatus'>,
  'method'
> & { readonly method: EndpointContract['method'] | 'head'; readonly responseSchema: z.ZodType<T> };

export interface ApiSessionPort {
  getAccessToken(): Promise<string | null>;
  refreshSession(): Promise<string | null>;
  signOutLocal(): Promise<void>;
}

export type ApiRequestTelemetry = {
  readonly requestId: string;
  readonly method: string;
};

export type ApiResponseTelemetry = {
  readonly requestId: string;
  readonly status: number;
  readonly serverRequestId?: string;
};

export type ApiAppGate = 'update' | 'maintenance';

export interface ApiTelemetryPort {
  onRequest(input: ApiRequestTelemetry): void;
  onResponse(input: ApiResponseTelemetry): void;
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId: string,
    readonly code: string | null,
    readonly translationKey: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export type ApiClientOptions = {
  readonly baseUrl: string;
  readonly appVersion: string;
  readonly platform: 'ios' | 'android';
  readonly fetch: typeof globalThis.fetch;
  readonly session: ApiSessionPort;
  readonly createRequestId: () => string;
  readonly translate: (key: string, options?: Readonly<Record<string, string>>) => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly timeoutMs?: number;
  readonly telemetry?: ApiTelemetryPort;
  readonly onContractMismatch?: (input: {
    readonly requestId: string;
    readonly path: string;
  }) => void;
  readonly onAppGate?: (gate: ApiAppGate) => void;
  readonly onAccountDeleted?: () => Promise<void>;
};

export type ApiRequestOptions = {
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  /** Bounds the entire request, including GET retries, backoff, and response parsing. */
  readonly totalTimeoutMs?: number;
};

export type ApiClient = {
  request<T>(endpoint: ApiEndpoint<T>, options?: ApiRequestOptions): Promise<T>;
};

type ReceivedResponse = {
  readonly response: Response;
  readonly requestId: string;
  readonly cleanup: () => void;
  readonly aborted: () => boolean;
  readonly attemptsUsed: number;
};

const apiTimeoutMs = 10_000;
const maxGetAttempts = 2;
const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class FetchAttemptError extends Error {
  constructor(readonly requestId: string) {
    super('The API request could not reach a response.');
    this.name = 'FetchAttemptError';
  }
}

function serverRequestId(response: Response): string | undefined {
  const candidate = response.headers.get('X-Request-Id');
  return candidate !== null && uuidV7Pattern.test(candidate) ? candidate : undefined;
}

async function isMaintenanceGateResponse(response: Response): Promise<boolean> {
  if (
    response.status !== 503 ||
    !response.headers.get('content-type')?.toLowerCase().includes('application/problem+json')
  ) {
    return false;
  }

  try {
    const parsed = ProblemDetailsSchema.safeParse(await response.clone().json());
    return parsed.success && parsed.data.code === 'app.maintenance';
  } catch {
    return false;
  }
}

export function createUuidV7(now = Date.now(), bytes = Crypto.getRandomBytes(16)): string {
  const timestamp = Math.floor(now);
  const uuid = Uint8Array.from(bytes);
  uuid[0] = (timestamp / 2 ** 40) & 0xff;
  uuid[1] = (timestamp / 2 ** 32) & 0xff;
  uuid[2] = (timestamp / 2 ** 24) & 0xff;
  uuid[3] = (timestamp / 2 ** 16) & 0xff;
  uuid[4] = (timestamp / 2 ** 8) & 0xff;
  uuid[5] = timestamp & 0xff;
  uuid[6] = ((uuid[6] ?? 0) & 0x0f) | 0x70;
  uuid[8] = ((uuid[8] ?? 0) & 0x3f) | 0x80;

  const hex = [...uuid].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isIdempotent(method: string, idempotencyKey: string | undefined): boolean {
  return method === 'get' || method === 'head' || idempotencyKey !== undefined;
}

function retryAfterMilliseconds(
  response: Response | null,
  random: () => number,
  attempt: number,
): number {
  const retryAfter = response?.headers.get('Retry-After') ?? null;
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 30_000);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.max(0, Math.min(date - Date.now(), 30_000));
    }
  }

  const base = 250 * 2 ** attempt;
  return Math.floor(base + base * Math.max(0, Math.min(random(), 1)));
}

function waitForRetry(
  milliseconds: number,
  signal: AbortSignal | undefined,
  sleep: ((milliseconds: number) => Promise<void>) | undefined,
): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(false);

  if (sleep === undefined) {
    return new Promise((resolve) => {
      const finish = (completed: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        resolve(completed);
      };
      const cancel = () => finish(false);
      const timer = setTimeout(() => finish(true), milliseconds);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  if (signal === undefined) return sleep(milliseconds).then(() => true);

  let removeAbortListener: () => void = () => undefined;
  const aborted = new Promise<boolean>((resolve) => {
    const cancel = () => resolve(false);
    signal.addEventListener('abort', cancel, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', cancel);
  });
  return Promise.race([sleep(milliseconds).then(() => true), aborted]).finally(removeAbortListener);
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  let refreshPromise: Promise<string | null> | null = null;
  const random = options.random ?? Math.random;
  const timeoutMs = options.timeoutMs ?? apiTimeoutMs;
  const baseUrl = options.baseUrl.replace(/\/$/, '');

  function recordRequest(requestId: string, method: string): void {
    try {
      options.telemetry?.onRequest({ requestId, method });
    } catch {
      // Telemetry must not change the API request outcome.
    }
  }

  function recordResponse(requestId: string, response: Response): void {
    const serverId = serverRequestId(response);
    try {
      options.telemetry?.onResponse({
        requestId,
        status: response.status,
        ...(serverId === undefined ? {} : { serverRequestId: serverId }),
      });
    } catch {
      // Telemetry must not change the API request outcome.
    }
  }

  function sharedRefresh(): Promise<string | null> {
    if (refreshPromise === null) {
      refreshPromise = options.session.refreshSession().finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  }

  async function fetchOnce<T>(
    endpoint: ApiEndpoint<T>,
    requestOptions: ApiRequestOptions,
    accessTokenOverride?: string | null,
    onRequestId?: (requestId: string) => void,
  ): Promise<ReceivedResponse> {
    if (baseUrl.length === 0) {
      const requestId = options.createRequestId();
      throw new ApiRequestError(
        options.translate('errors.unknown', { requestId }),
        0,
        requestId,
        null,
        'errors.unknown',
      );
    }

    const requestId = options.createRequestId();
    if (!uuidV7Pattern.test(requestId)) {
      throw new ApiRequestError(
        options.translate('errors.generic'),
        0,
        requestId,
        null,
        'errors.generic',
      );
    }
    onRequestId?.(requestId);
    const controller = new AbortController();
    const requestSignal = requestOptions.signal;
    const cleanup = () => {
      clearTimeout(timeout);
      requestSignal?.removeEventListener('abort', abortRequest);
    };
    const abortRequest = () => {
      controller.abort();
      cleanup();
    };
    const timeout = setTimeout(() => {
      controller.abort();
      requestSignal?.removeEventListener('abort', abortRequest);
    }, timeoutMs);
    if (requestSignal?.aborted === true) {
      abortRequest();
    } else {
      requestSignal?.addEventListener('abort', abortRequest, { once: true });
    }
    try {
      const headers = new Headers(requestOptions.headers);
      headers.delete('Authorization');
      headers.set('X-Request-Id', requestId);
      headers.set('X-App-Version', options.appVersion);
      headers.set('X-Platform', options.platform);

      if (requestOptions.idempotencyKey !== undefined) {
        headers.set('Idempotency-Key', requestOptions.idempotencyKey);
      }
      if (requestOptions.body !== undefined) {
        headers.set('Content-Type', 'application/json');
      }

      if (endpoint.security.length > 0) {
        const accessToken =
          accessTokenOverride === undefined
            ? await options.session.getAccessToken()
            : accessTokenOverride;
        if (controller.signal.aborted) throw new FetchAttemptError(requestId);
        if (accessToken !== null) {
          headers.set('Authorization', `Bearer ${accessToken}`);
        }
      } else {
        headers.delete('Authorization');
      }

      if (controller.signal.aborted) throw new FetchAttemptError(requestId);

      const init: RequestInit = {
        method: endpoint.method.toUpperCase(),
        headers,
        signal: controller.signal,
        ...(requestOptions.body === undefined ? {} : { body: JSON.stringify(requestOptions.body) }),
      };
      recordRequest(requestId, endpoint.method.toUpperCase());
      const response = await options.fetch(`${baseUrl}${endpoint.path}`, init);
      recordResponse(requestId, response);
      return {
        response,
        requestId,
        cleanup,
        aborted: () => controller.signal.aborted,
        attemptsUsed: 1,
      };
    } catch (error) {
      cleanup();
      if (error instanceof ApiRequestError) {
        throw error;
      }
      throw new FetchAttemptError(requestId);
    }
  }

  async function fetchWithGetRetries<T>(
    endpoint: ApiEndpoint<T>,
    requestOptions: ApiRequestOptions,
    accessTokenOverride?: string | null,
    startingAttempt = 0,
    onRequestId?: (requestId: string) => void,
  ): Promise<ReceivedResponse> {
    const retryable = endpoint.method === 'get';
    for (let attempt = startingAttempt; ; attempt += 1) {
      try {
        const result = await fetchOnce(endpoint, requestOptions, accessTokenOverride, onRequestId);
        const maintenanceGate = await isMaintenanceGateResponse(result.response);
        if (
          retryable &&
          attempt + 1 < maxGetAttempts &&
          !maintenanceGate &&
          (result.response.status >= 500 || result.response.status === 429)
        ) {
          void result.response.body?.cancel().catch(() => undefined);
          result.cleanup();
          if (requestOptions.signal?.aborted === true) {
            throw createTransportError(result.requestId);
          }
          const shouldRetry = await waitForRetry(
            retryAfterMilliseconds(result.response, random, attempt),
            requestOptions.signal,
            options.sleep,
          );
          if (!shouldRetry) throw createTransportError(result.requestId);
          continue;
        }
        return { ...result, attemptsUsed: attempt + 1 };
      } catch (error) {
        if (error instanceof ApiRequestError) {
          throw error;
        }
        const requestId =
          error instanceof FetchAttemptError ? error.requestId : options.createRequestId();
        if (
          !retryable ||
          attempt + 1 >= maxGetAttempts ||
          requestOptions.signal?.aborted === true
        ) {
          throw createTransportError(requestId);
        }
        const shouldRetry = await waitForRetry(
          retryAfterMilliseconds(null, random, attempt),
          requestOptions.signal,
          options.sleep,
        );
        if (!shouldRetry) throw createTransportError(requestId);
      }
    }
  }

  function createTransportError(requestId: string): ApiRequestError {
    return new ApiRequestError(
      options.translate('errors.generic', { requestId }),
      0,
      requestId,
      null,
      'errors.generic',
    );
  }

  async function parseProblem(result: ReceivedResponse): Promise<ApiRequestError> {
    const { response, requestId: fallbackRequestId } = result;
    let details: ProblemDetails | null = null;
    if (response.headers.get('content-type')?.toLowerCase().includes('application/problem+json')) {
      try {
        const parsed = ProblemDetailsSchema.safeParse(await response.json());
        details = parsed.success ? parsed.data : null;
      } catch (error) {
        if (result.aborted() || !(error instanceof SyntaxError)) {
          throw createTransportError(fallbackRequestId);
        }
        details = null;
      }
    }

    const requestId = details?.requestId ?? serverRequestId(response) ?? fallbackRequestId;
    const code = details?.code ?? null;
    const translationKey = code === null ? 'errors.generic' : `errors.${code}`;
    return new ApiRequestError(
      options.translate(translationKey, { requestId }),
      response.status,
      requestId,
      code,
      translationKey,
    );
  }

  async function finishResponse<T>(endpoint: ApiEndpoint<T>, result: ReceivedResponse): Promise<T> {
    try {
      const { response, requestId } = result;
      if (!response.ok) {
        const error = await parseProblem(result);
        const gate =
          error.code === 'app.update_required'
            ? 'update'
            : error.code === 'app.maintenance'
              ? 'maintenance'
              : null;
        if (gate !== null) {
          try {
            options.onAppGate?.(gate);
          } catch {
            // A navigation subscriber must not change the API response outcome.
          }
        }
        throw error;
      }

      if (response.status === 204 || endpoint.method === 'head') {
        return endpoint.responseSchema.parse(undefined);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (result.aborted() || !(error instanceof SyntaxError)) {
          throw createTransportError(requestId);
        }
        payload = undefined;
      }

      const parsed = endpoint.responseSchema.safeParse(payload);
      if (!parsed.success) {
        const correlationId = serverRequestId(response) ?? requestId;
        options.onContractMismatch?.({ requestId: correlationId, path: endpoint.path });
        throw new ApiRequestError(
          options.translate('errors.client.contract_mismatch', { requestId: correlationId }),
          response.status,
          correlationId,
          'client.contract_mismatch',
          'errors.client.contract_mismatch',
        );
      }
      return parsed.data;
    } finally {
      result.cleanup();
    }
  }

  async function executeRequest<T>(
    endpoint: ApiEndpoint<T>,
    requestOptions: ApiRequestOptions,
    onRequestId: (requestId: string) => void,
  ): Promise<T> {
    let firstResult: ReceivedResponse;
    let attemptsUsed = 0;
    for (;;) {
      firstResult = await fetchWithGetRetries(
        endpoint,
        requestOptions,
        undefined,
        attemptsUsed,
        onRequestId,
      );
      attemptsUsed = firstResult.attemptsUsed;
      if (firstResult.response.status === 401 && endpoint.security.length > 0) {
        break;
      }
      try {
        return await finishResponse(endpoint, firstResult);
      } catch (error) {
        if (
          !(error instanceof ApiRequestError) ||
          error.status !== 0 ||
          endpoint.method !== 'get' ||
          attemptsUsed >= maxGetAttempts
        ) {
          throw error;
        }
        const shouldRetry = await waitForRetry(
          retryAfterMilliseconds(null, random, attemptsUsed - 1),
          requestOptions.signal,
          options.sleep,
        );
        if (!shouldRetry) throw createTransportError(firstResult.requestId);
      }
    }

    if (firstResult.response.status !== 401 || endpoint.security.length === 0) {
      return finishResponse(endpoint, firstResult);
    }

    let firstProblem: ApiRequestError;
    try {
      firstProblem = await parseProblem({
        ...firstResult,
        response: firstResult.response.clone(),
      });
    } finally {
      await firstResult.response.body?.cancel().catch(() => undefined);
      firstResult.cleanup();
    }
    if (firstProblem.code === 'auth.recent_auth_required') {
      throw firstProblem;
    }
    if (firstProblem.code === 'auth.account_deleted') {
      await options.session.signOutLocal();
      await options.onAccountDeleted?.();
      throw firstProblem;
    }

    let refreshedToken: string | null;
    try {
      refreshedToken = await sharedRefresh();
    } catch {
      refreshedToken = null;
    }
    if (refreshedToken === null) {
      await options.session.signOutLocal();
      throw firstProblem;
    }

    if (!isIdempotent(endpoint.method, requestOptions.idempotencyKey)) {
      throw firstProblem;
    }

    try {
      firstResult = await fetchOnce(endpoint, requestOptions, refreshedToken, onRequestId);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        throw error;
      }
      const requestId =
        error instanceof FetchAttemptError ? error.requestId : options.createRequestId();
      throw createTransportError(requestId);
    }
    if (firstResult.response.status === 401) {
      try {
        const secondProblem = await parseProblem(firstResult);
        await options.session.signOutLocal();
        throw secondProblem;
      } finally {
        firstResult.cleanup();
      }
    }
    return finishResponse(endpoint, firstResult);
  }

  return {
    async request<T>(endpoint: ApiEndpoint<T>, requestOptions: ApiRequestOptions = {}): Promise<T> {
      const { signal: externalSignal, totalTimeoutMs, ...requestInputs } = requestOptions;
      const requestController = new AbortController();
      let activeRequestId: string | null = null;
      const captureRequestId = (requestId: string) => {
        activeRequestId = requestId;
      };
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let removeExternalAbort: (() => void) | undefined;
      if (externalSignal !== undefined) {
        const abortFromCaller = () => requestController.abort();
        if (externalSignal.aborted) {
          requestController.abort();
        } else {
          externalSignal.addEventListener('abort', abortFromCaller, { once: true });
          removeExternalAbort = () => externalSignal.removeEventListener('abort', abortFromCaller);
        }
      }

      const requestScopedOptions: ApiRequestOptions = {
        ...requestInputs,
        signal: requestController.signal,
      };
      let deadline: Promise<never> | null = null;
      if (totalTimeoutMs !== undefined && Number.isFinite(totalTimeoutMs) && totalTimeoutMs > 0) {
        deadline = new Promise<never>((_resolve, reject) => {
          deadlineTimer = setTimeout(() => {
            requestController.abort();
            reject(createTransportError(activeRequestId ?? options.createRequestId()));
          }, totalTimeoutMs);
        });
      }

      try {
        const execution = executeRequest(endpoint, requestScopedOptions, captureRequestId);
        return await (deadline === null ? execution : Promise.race([execution, deadline]));
      } finally {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        removeExternalAbort?.();
      }
    },
  };
}
