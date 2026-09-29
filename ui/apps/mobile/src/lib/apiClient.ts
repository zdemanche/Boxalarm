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

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
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

  let response = await send(await tokens.getAccessToken());

  if (response.status === 401) {
    const renewedToken = await tokens.renewSilently();
    if (renewedToken) {
      response = await send(renewedToken);
    }
  }

  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as ProblemDetails | null;
    throw new ApiError(
      problem ?? {
        type: 'about:blank',
        title: response.statusText,
        status: response.status,
        traceId: 'unknown',
      },
    );
  }

  return response;
}
