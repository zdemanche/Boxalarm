import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed-webhook checks (docs/decisions/2026-09-29-cad-ingress-auth.md, "Webhook path"):
 * `X-Boxalarm-Signature: v1=<hex>[, v1=<hex>]` is HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 * over the RAW request bytes, compared in constant time, accepted when any listed signature
 * matches either active key (current or previous, for rotation without downtime).
 *
 * Deliberately NOT modelled on receipts/vendorAuth.ts (a static shared secret, no replay
 * protection).
 */

export const FRESHNESS_WINDOW_SECONDS = 300;
/** More than twice the freshness window, so every request inside the window stays cached. */
export const REPLAY_TTL_SECONDS = 900;
const MAX_SIGNATURES = 5;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isFreshTimestamp(header: string | undefined, nowSeconds: number): boolean {
  if (!header || !/^\d{1,12}$/.test(header)) return false;
  return Math.abs(nowSeconds - Number(header)) <= FRESHNESS_WINDOW_SECONDS;
}

/** The v1 signatures in the header, lower-cased; anything malformed is ignored. */
export function parseSignatureHeader(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .slice(0, MAX_SIGNATURES)
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1='))
    .map((part) => part.slice(3).toLowerCase())
    .filter((hex) => SHA256_HEX.test(hex));
}

export function computeSignature(key: string, timestamp: string, rawBody: Buffer): Buffer {
  return createHmac('sha256', key)
    .update(Buffer.from(`${timestamp}.`, 'utf8'))
    .update(rawBody)
    .digest();
}

/**
 * The matching signature (hex) when any listed signature is valid under any key, else
 * undefined. Every comparison is a timingSafeEqual on two 32-byte digests, and every pair is
 * compared (no early exit on the key), so timing reveals neither which check nor which key.
 */
export function verifySignature(
  keys: readonly string[],
  timestamp: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): string | undefined {
  const provided = parseSignatureHeader(signatureHeader);
  const expected = keys.map((key) => computeSignature(key, timestamp, rawBody));
  let match: string | undefined;
  for (const hex of provided) {
    const candidate = Buffer.from(hex, 'hex');
    for (const digest of expected) {
      if (candidate.length === digest.length && timingSafeEqual(candidate, digest)) {
        match ??= hex;
      }
    }
  }
  return match;
}
