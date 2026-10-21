export interface AuthTokenSource {
  getAccessToken: () => Promise<string | null>;
  renewSilently: () => Promise<string | null>;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  traceId: string;
}

export class ApiError extends Error {
  constructor(public readonly problem: ProblemDetails) {
    super(problem.title);
  }
}

const UNKNOWN_TRACE_ID = 'unknown';

// The API Gateway answers a rejected or missing token itself (401, or 403 from the authorizer)
// with a bare { message } body; every backend problem carries a traceId. A gateway 403 is a
// sign-in or authorizer problem that a new session or a later try can clear, not a refusal of
// this request. Any other 403 without a backend problem body (a WAF block) matches too: it is
// treated as recoverable and retried.
export function isGatewayDenial(error: ApiError): boolean {
  const { status, traceId } = error.problem;
  return status === 403 && traceId === UNKNOWN_TRACE_ID;
}

/** A request that got no answer within its time limit. Never a 4xx/5xx: the server may not have
 * seen it at all, so callers treat it like "unreachable", not like a refusal. */
export class ApiTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`No response from the server within ${Math.round(timeoutMs / 1000)} seconds`);
    this.name = 'ApiTimeoutError';
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
  apiBaseUrl: string;
  /** Per attempt (the 401 renew-and-retry is a second attempt with its own limit). Defaults to
   * DEFAULT_TIMEOUT_MS; a fetch with no limit can hang forever on a half-dead LTE link. */
  timeoutMs?: number;
}

const API_PATH_PREFIX = '/api/v1/';

/** Long enough for a slow rural link, short enough that nobody stares at a spinner. */
export const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const callerSignal = init.signal;
  const forwardAbort = () => controller.abort();
  callerSignal?.addEventListener('abort', forwardAbort);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new ApiTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
  }
}

/**
 * Token acquisition can hang too (a keychain read, or a refresh against an unreachable identity
 * provider) - bounded by the same limit as the request, so the alert screen or a headless answer
 * never waits on it forever (review m8).
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ApiTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export async function apiRequest(
  path: string,
  tokens: AuthTokenSource,
  options: ApiRequestOptions,
): Promise<Response> {
  const { apiBaseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = options;
  const send = (token: string | null) =>
    fetchWithTimeout(
      `${apiBaseUrl}${API_PATH_PREFIX}${path}`,
      {
        ...init,
        headers: {
          ...init.headers,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      timeoutMs,
    );

  let response = await send(await withTimeout(tokens.getAccessToken(), timeoutMs));

  if (response.status === 401) {
    const renewedToken = await withTimeout(tokens.renewSilently(), timeoutMs);
    if (renewedToken) {
      response = await send(renewedToken);
    }
  }

  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as
      (Partial<ProblemDetails> & { message?: string }) | null;
    throw new ApiError({
      type: 'about:blank',
      title: problem?.message ?? response.statusText,
      traceId: UNKNOWN_TRACE_ID,
      ...problem,
      status: response.status,
    });
  }

  return response;
}
