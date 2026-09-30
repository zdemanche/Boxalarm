import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { ALERTING_SDK_CLIENT_CONFIG } from '../awsClientConfig.js';

/**
 * The HMAC keys of one webhook source: a Secrets Manager secret `{ current, previous? }`
 * written by the chief's key-rotation route. Cached per warm Lambda for at most 5 minutes
 * (cad-ingress-auth: "Cache the secrets in the Lambda for at most 5 minutes"), so a rotation
 * reaches every instance within that time while `previous` keeps the old key valid.
 */

export const KEY_CACHE_TTL_MS = 5 * 60 * 1000;
export const KEY_REFRESH_MIN_AGE_MS = 5 * 1000;
const MIN_KEY_LENGTH = 32;

let client: SecretsManagerClient | undefined;
const cache = new Map<string, { readonly keys: readonly string[]; readonly loadedAt: number }>();

function getClient(): SecretsManagerClient {
  client ??= captureAWSv3Client(new SecretsManagerClient(ALERTING_SDK_CLIENT_CONFIG));
  return client;
}

/** Test seam. */
export function resetWebhookKeyCache(override?: SecretsManagerClient): void {
  cache.clear();
  client = override;
}

/**
 * The active keys in a source's secret, current first - but only when the secret names this
 * source as its owner (security review M1): a secret written for another department or source
 * yields no key, so the request fails closed (NoActiveKey).
 */
export function parseWebhookSecret(
  secretString: string | undefined,
  owner: { readonly deptId: string; readonly sourceId: string },
): string[] {
  if (!secretString) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const { deptId, sourceId, current, previous } = parsed as Record<string, unknown>;
  if (deptId !== owner.deptId || sourceId !== owner.sourceId) return [];
  return [current, previous].filter(
    (key): key is string => typeof key === 'string' && key.length >= MIN_KEY_LENGTH,
  );
}

/** The active keys (current first). Empty when the secret has none. Throws on a read error. */
export async function getWebhookKeys(
  secretName: string,
  owner: { readonly deptId: string; readonly sourceId: string },
  now = Date.now(),
): Promise<string[]> {
  const cached = cache.get(secretName);
  if (cached && now - cached.loadedAt < KEY_CACHE_TTL_MS) {
    return [...cached.keys];
  }
  const output = await getClient().send(new GetSecretValueCommand({ SecretId: secretName }));
  const keys = parseWebhookSecret(output.SecretString, owner);
  cache.set(secretName, { keys, loadedAt: now });
  return keys;
}

/**
 * A request failed the signature against the cached keys: if that cache entry is older than
 * `minAgeMs`, re-read the secret once and return the fresh keys (chain review M4 - a CAD that
 * switches to a just-rotated key must not get 401 for up to 5 minutes). Undefined when the
 * cache is fresh enough that a re-read cannot help; the minimum age bounds how often a flood of
 * bad signatures can make this Lambda call Secrets Manager.
 */
export async function refreshWebhookKeysIfStale(
  secretName: string,
  owner: { readonly deptId: string; readonly sourceId: string },
  minAgeMs = KEY_REFRESH_MIN_AGE_MS,
  now = Date.now(),
): Promise<string[] | undefined> {
  const cached = cache.get(secretName);
  if (cached && now - cached.loadedAt < minAgeMs) return undefined;
  cache.delete(secretName);
  return getWebhookKeys(secretName, owner, now);
}
