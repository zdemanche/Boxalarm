import type { NerisConfig } from './config.js';

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
    throw new Error(`NERIS token endpoint returned HTTP ${response.status}`);
  }

  let body: TokenResponseBody;
  try {
    body = (await response.json()) as TokenResponseBody;
  } catch {
    throw new Error('NERIS token endpoint returned non-JSON body');
  }

  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new Error('NERIS token response missing access_token');
  }

  const expiresInSeconds =
    typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0
      ? body.expires_in
      : 3600;

  return { accessToken: body.access_token, expiresInSeconds };
}

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

  const acquiredAt = nowMs();
  const refreshed = await requestAccessToken(config, fetchFn);
  const entry: CachedAccessToken = {
    accessToken: refreshed.accessToken,
    expiresAtMs: acquiredAt + refreshed.expiresInSeconds * 1000,
  };
  cache.set(entry);
  return entry.accessToken;
}
