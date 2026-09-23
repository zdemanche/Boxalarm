import { randomUUID } from 'node:crypto';
import { createLogger } from '@boxalarm/logging';
import type { NerisConfig } from './config.js';

const logger = createLogger({ service: 'incident-service' });

/** Refresh when remaining lifetime is at or below this skew (AC3). */
export const NEAR_EXPIRY_SKEW_MS = 60_000;

export type FetchFn = typeof fetch;

export interface CachedAccessToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

export interface TokenCache {
  get(): CachedAccessToken | undefined;
  set(entry: CachedAccessToken): void;
  clear(): void;
}

export function createTokenCache(): TokenCache {
  let entry: CachedAccessToken | undefined;
  return {
    get: () => entry,
    set: (next) => {
      entry = next;
    },
    clear: () => {
      entry = undefined;
    },
  };
}

let cachedTokenCache: TokenCache | undefined;

/**
 * Returns a module-scope singleton {@link TokenCache}, mirroring config.ts's
 * cached-client pattern (`cachedSsmClient ??= ...`), so the near-expiry token
 * reuse in {@link getAccessToken} survives across warm Lambda invocations
 * instead of starting from an empty cache on every invocation.
 */
export function getTokenCache(cache?: TokenCache): TokenCache {
  cachedTokenCache ??= cache ?? createTokenCache();
  return cachedTokenCache;
}

export interface GetAccessTokenDeps {
  readonly fetchFn?: FetchFn;
  readonly cache?: TokenCache;
  readonly nowMs?: () => number;
}

interface TokenResponseBody {
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
  readonly token_type?: unknown;
}

function isUsable(entry: CachedAccessToken, nowMs: number): boolean {
  return entry.expiresAtMs - nowMs > NEAR_EXPIRY_SKEW_MS;
}

function buildTokenUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/token`;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
}

async function requestAccessToken(
  config: NerisConfig,
  fetchFn: FetchFn,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const response = await fetchFn(buildTokenUrl(config.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(config.clientId, config.clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': config.userAgent,
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    logger.error({
      event: 'neris.token.http_error',
      correlationId: randomUUID(),
      status: response.status,
    });
    throw new Error(`NERIS token endpoint returned HTTP ${response.status}`);
  }

  let body: TokenResponseBody;
  try {
    body = (await response.json()) as TokenResponseBody;
  } catch {
    logger.error({
      event: 'neris.token.invalid_json',
      correlationId: randomUUID(),
    });
    throw new Error('NERIS token endpoint returned non-JSON body');
  }

  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    logger.error({
      event: 'neris.token.missing_access_token',
      correlationId: randomUUID(),
    });
    throw new Error('NERIS token response missing access_token');
  }

  const expiresInSeconds =
    typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0
      ? body.expires_in
      : 3600;

  return { accessToken: body.access_token, expiresInSeconds };
}

// Tracks an in-flight token request per TokenCache instance so concurrent
// callers that both observe an expired/empty cache coalesce onto the same
// request instead of each independently calling the NERIS token endpoint.
const inFlightRequests = new WeakMap<TokenCache, Promise<string>>();

/**
 * Returns a cached OAuth2 access token, refreshing when near expiry so the
 * in-flight NERIS call still receives a usable token (E6-S7 AC3).
 */
export async function getAccessToken(
  config: NerisConfig,
  deps: GetAccessTokenDeps = {},
): Promise<string> {
  const fetchFn = deps.fetchFn ?? fetch;
  const cache = deps.cache ?? createTokenCache();
  const nowMs = deps.nowMs ?? Date.now;

  const existing = cache.get();
  if (existing && isUsable(existing, nowMs())) {
    return existing.accessToken;
  }

  const pending = inFlightRequests.get(cache);
  if (pending) {
    return pending;
  }

  const acquiredAt = nowMs();
  const requestPromise = requestAccessToken(config, fetchFn)
    .then((refreshed) => {
      const entry: CachedAccessToken = {
        accessToken: refreshed.accessToken,
        expiresAtMs: acquiredAt + refreshed.expiresInSeconds * 1000,
      };
      cache.set(entry);
      return entry.accessToken;
    })
    .finally(() => {
      inFlightRequests.delete(cache);
    });

  inFlightRequests.set(cache, requestPromise);
  return requestPromise;
}
