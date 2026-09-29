import type { NerisConfig } from './config.js';
import {
  createTokenCache,
  getAccessToken,
  getTokenCache,
  type FetchFn,
  type TokenCache,
} from './tokenCache.js';

export interface NerisClient {
  /**
   * Performs an authenticated NERIS HTTP request.
   * Always sets User-Agent from config and Authorization from the token cache;
   * call sites cannot omit or override those headers.
   */
  fetch(pathOrUrl: string, init?: RequestInit): Promise<Response>;
}

export interface CreateNerisClientDeps {
  readonly fetchFn?: FetchFn;
  readonly tokenCache?: TokenCache;
  readonly nowMs?: () => number;
  /** Per-call timeout; defaults to {@link NERIS_CALL_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * Every NERIS call is abandoned after this long. The submission worker's worst chain is
 * seven calls — token, up to two adopt lookups, the POST, up to two adopt lookups after a
 * refused create, then the PUT — 28 s; a 401 on each call (token dropped, fetched again
 * and the call repeated once) adds 8 s per call, 76 s at most. The worker Lambda
 * runs one report per invocation with a 90 s timeout and a 540 s queue visibility timeout
 * (infrastructure/components/incident/submission-worker.ts). The HTTP routes make at most
 * a token fetch and one call (validate, entity reads) — 8 s, or 16 s with a 401 retry —
 * inside API Gateway's 30 s limit. A send cut off part-way is still safe: the create
 * marker plus adopt-before-create make a redelivery idempotent (review M2, round 2 N10).
 */
export const NERIS_CALL_TIMEOUT_MS = 4_000;

/**
 * Resolves a relative path against the configured base URL, or accepts an
 * absolute URL only when its hostname matches the configured base hostname.
 */
export function resolveUrl(baseUrl: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    let requested: URL;
    let configured: URL;
    try {
      requested = new URL(pathOrUrl);
      configured = new URL(baseUrl);
    } catch {
      throw new Error(`NERIS request URL is not a valid URL: ${pathOrUrl}`);
    }
    if (requested.hostname.toLowerCase() !== configured.hostname.toLowerCase()) {
      throw new Error(
        `NERIS request URL host "${requested.hostname}" does not match configured base host "${configured.hostname}"`,
      );
    }
    return pathOrUrl;
  }
  const base = baseUrl.replace(/\/+$/, '');
  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `${base}${path}`;
}

function mergeHeaders(
  init: RequestInit | undefined,
  userAgent: string,
  accessToken: string,
): Headers {
  const headers = new Headers(init?.headers);
  // Mandatory headers are owned by the shared client (E6-S7 AC2).
  headers.set('User-Agent', userAgent);
  headers.set('Authorization', `Bearer ${accessToken}`);
  return headers;
}

/**
 * Creates a shared NERIS HTTP client that structurally attaches User-Agent
 * and Bearer Authorization on every request.
 */
export function createNerisClient(
  config: NerisConfig,
  deps: CreateNerisClientDeps = {},
): NerisClient {
  const fetchFn = deps.fetchFn ?? fetch;
  const tokenCache = deps.tokenCache ?? createTokenCache();
  const nowMs = deps.nowMs ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? NERIS_CALL_TIMEOUT_MS;

  return {
    async fetch(pathOrUrl: string, init?: RequestInit): Promise<Response> {
      const url = resolveUrl(config.baseUrl, pathOrUrl);
      const send = async (): Promise<Response> => {
        const accessToken = await getAccessToken(config, {
          fetchFn,
          cache: tokenCache,
          nowMs,
          timeoutMs,
        });
        return fetchFn(url, {
          ...init,
          headers: mergeHeaders(init, config.userAgent, accessToken),
          signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
        });
      };
      const response = await send();
      if (response.status !== 401) {
        return response;
      }
      // A cached token NERIS no longer honours (revoked or rotated server-side) would
      // otherwise fail every call until it expired: drop it and try once with a fresh one.
      tokenCache.clear();
      return send();
    },
  };
}

let cachedNerisClient: NerisClient | undefined;

/**
 * Returns a module-scope singleton {@link NerisClient}, mirroring config.ts's
 * cached-client pattern (`cachedSsmClient ??= ...`). Handlers should call this
 * instead of {@link createNerisClient} directly: calling `createNerisClient`
 * itself inside a handler body creates a fresh, empty token cache on every
 * invocation, defeating the near-expiry token reuse in tokenCache.ts and
 * multiplying calls to the NERIS token endpoint across the Lambda fleet.
 * The client (and its token cache) survive across warm invocations by default.
 */
export function getNerisClient(config: NerisConfig, deps: CreateNerisClientDeps = {}): NerisClient {
  cachedNerisClient ??= createNerisClient(config, {
    ...deps,
    tokenCache: deps.tokenCache ?? getTokenCache(),
  });
  return cachedNerisClient;
}
