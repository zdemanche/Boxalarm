import { describe, expect, it } from 'vitest';
import {
  apnsIdFor,
  buildNonCriticalApnsPayload,
  buildNonCriticalFcmRequest,
  NON_CRITICAL_PUSH_CATEGORY,
  NON_CRITICAL_TEXT_MAX_BYTES,
  nonCriticalApnsHeaders,
  NOTIFICATION_DEEP_LINK_PATH,
  truncateUtf8,
  type NonCriticalPush,
} from './nonCriticalPush.js';

const PUSH: NonCriticalPush = {
  title: 'Apparatus status changed',
  body: 'Engine 1 — out of service: pump failure',
  notificationCategory: 'apparatus-status',
  idempotencyKey: 'NICHOLS#MBR-1#apparatus-status#corr-1',
};

describe('buildNonCriticalApnsPayload — non-critical by construction', () => {
  const payload = buildNonCriticalApnsPayload(PUSH);
  const aps = payload.aps as Record<string, unknown>;

  it('is an ordinary active alert: default sound, no critical dictionary', () => {
    expect(aps['interruption-level']).toBe('active');
    expect(aps.sound).toBe('default');
  });

  it('carries no action category and no mutable-content (nothing a page has)', () => {
    expect(aps.category).toBeUndefined();
    expect(aps['mutable-content']).toBeUndefined();
  });

  it('routes the app to the non-critical channel and the inbox', () => {
    expect(payload.category).toBe(NON_CRITICAL_PUSH_CATEGORY);
    expect(payload.category).toBe('digest');
    expect(payload.path).toBe(NOTIFICATION_DEEP_LINK_PATH);
    expect(payload.notificationCategory).toBe('apparatus-status');
  });

  it('serializes with no critical or dispatch marker anywhere (negative control)', () => {
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/critical/i);
    expect(serialized).not.toMatch(/DISPATCH/);
  });

  it('stays under the 4096-byte APNs cap at the worst-case text lengths', () => {
    const worst = buildNonCriticalApnsPayload({
      ...PUSH,
      title: '🚒'.repeat(400),
      body: '🚒'.repeat(2000),
      notificationCategory: 'x'.repeat(64),
    });
    expect(Buffer.byteLength(JSON.stringify(worst))).toBeLessThan(4096);
  });
});

describe('nonCriticalApnsHeaders', () => {
  const headers = nonCriticalApnsHeaders(PUSH, 1_700_000_000_000);

  it('is an ordinary alert push with a bounded expiry', () => {
    expect(headers['apns-push-type']).toBe('alert');
    expect(headers['apns-priority']).toBe('10');
    expect(headers['apns-expiration']).toBe(String(1_700_000_000 + 86_400));
  });

  it('derives a stable UUID apns-id and a 64-byte collapse id from the idempotency key', () => {
    expect(headers['apns-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(headers['apns-id']).toBe(apnsIdFor(PUSH.idempotencyKey));
    expect(nonCriticalApnsHeaders(PUSH, 1)['apns-id']).toBe(headers['apns-id']);
    expect(Buffer.byteLength(headers['apns-collapse-id'] as string)).toBeLessThanOrEqual(64);
  });
});

describe('buildNonCriticalFcmRequest — non-critical by construction', () => {
  const request = buildNonCriticalFcmRequest(PUSH, 'fcm-token-1', 1_700_000_000_000);
  const message = request.message as Record<string, unknown>;

  it('is a NORMAL-priority data-only Android message on the default channel route', () => {
    expect(message.notification).toBeUndefined();
    expect(message.android).toEqual({ priority: 'NORMAL', ttl: '86400s' });
    const data = message.data as Record<string, string>;
    expect(data.category).toBe('digest');
    expect(data.path).toBe(NOTIFICATION_DEEP_LINK_PATH);
    expect(data.title).toBe(PUSH.title);
    expect(data.body).toBe(PUSH.body);
  });

  it('never asks for validate_only (this worker has no test mode)', () => {
    expect(request.validate_only).toBeUndefined();
  });

  it('gives a legacy-token iOS device the same non-critical payload', () => {
    const apns = message.apns as { payload: Record<string, unknown> };
    expect(JSON.stringify(apns.payload)).not.toMatch(/critical/i);
    expect((apns.payload.aps as Record<string, unknown>)['interruption-level']).toBe('active');
  });

  it('serializes with no HIGH priority and no dispatch marker (negative control)', () => {
    const serialized = JSON.stringify(request);
    expect(serialized).not.toMatch(/HIGH/);
    expect(serialized).not.toMatch(/DISPATCH/);
    expect(serialized).not.toMatch(/dispatch-critical/);
  });
});

describe('truncateUtf8', () => {
  it('bounds the digest body without splitting a character', () => {
    const body = '🚒'.repeat(600);
    const bounded = truncateUtf8(body, NON_CRITICAL_TEXT_MAX_BYTES.body);
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(NON_CRITICAL_TEXT_MAX_BYTES.body);
    expect(bounded.endsWith('…')).toBe(true);
  });

  it('returns short text unchanged', () => {
    expect(truncateUtf8('ok', 128)).toBe('ok');
  });
});
