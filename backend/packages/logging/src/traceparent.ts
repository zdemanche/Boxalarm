import { randomBytes, randomUUID } from 'node:crypto';

export interface ParsedTraceparent {
  readonly version: string;
  readonly traceId: string;
  readonly parentId: string;
  readonly flags: string;
}

// W3C Trace Context: version-traceid-parentid-flags
const TRACEPARENT_RE = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/i;

export type HeaderBag =
  Record<string, string | undefined> | { get?(name: string): string | null | undefined };

function headerValue(headers: HeaderBag | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  if (typeof (headers as { get?(n: string): string | null | undefined }).get === 'function') {
    const v = (headers as { get(n: string): string | null | undefined }).get(name);
    return v ?? undefined;
  }
  const record = headers as Record<string, string | undefined>;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === lower && value) {
      return value;
    }
  }
  return undefined;
}

export function parseTraceparent(header: string | undefined): ParsedTraceparent | undefined {
  if (!header) {
    return undefined;
  }
  const match = TRACEPARENT_RE.exec(header.trim());
  if (!match) {
    return undefined;
  }
  const [, version, traceId, parentId, flags] = match;
  if (!version || !traceId || !parentId || !flags) {
    return undefined;
  }
  // All-zero trace-id / parent-id are invalid per the spec.
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) {
    return undefined;
  }
  return {
    version: version.toLowerCase(),
    traceId: traceId.toLowerCase(),
    parentId: parentId.toLowerCase(),
    flags: flags.toLowerCase(),
  };
}

export function generateTraceparent(traceId?: string): string {
  const id = (traceId ?? randomBytes(16).toString('hex')).toLowerCase();
  if (!/^[\da-f]{32}$/.test(id) || /^0+$/.test(id)) {
    throw new Error('traceId must be 32 lowercase hex characters and non-zero');
  }
  const parentId = randomBytes(8).toString('hex');
  return `00-${id}-${parentId}-01`;
}

/** Prefer W3C traceparent trace-id; fall back to x-correlation-id; else new UUID. */
export function extractCorrelationId(headers?: HeaderBag): string {
  const traceparent = headerValue(headers, 'traceparent');
  const parsed = parseTraceparent(traceparent);
  if (parsed) {
    return parsed.traceId;
  }
  const explicit =
    headerValue(headers, 'x-correlation-id') ?? headerValue(headers, 'x-correlationid');
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }
  return randomUUID();
}

/**
 * Propagate an incoming W3C traceparent header, or generate a fresh one.
 *
 * Per the W3C Trace Context spec, a service that receives no valid `traceparent`
 * header is the root of a new trace: it must mint a brand-new trace-id and
 * parent-id (span-id) rather than fail the request. Note this intentionally does
 * NOT fall back through `extractCorrelationId` — that helper's own fallback can
 * return a UUID (with dashes), which is not a valid 32-hex-char trace-id and
 * would make `generateTraceparent` throw.
 */
export function extractTraceparent(headers?: HeaderBag): string {
  const existing = parseTraceparent(headerValue(headers, 'traceparent'));
  if (existing) {
    return `00-${existing.traceId}-${existing.parentId}-${existing.flags}`;
  }
  return generateTraceparent();
}
