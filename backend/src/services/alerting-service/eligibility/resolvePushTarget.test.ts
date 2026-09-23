import { describe, expect, it } from 'vitest';
import { NO_TOKEN_REGISTERED_REASON, resolvePushTarget } from './resolvePushTarget.js';

describe('resolvePushTarget', () => {
  it('skips with the recorded reason, never throwing, when contactChannels is empty (core-harm — AC3)', () => {
    expect(resolvePushTarget([])).toEqual({ skipped: true, reason: NO_TOKEN_REGISTERED_REASON });
  });

  it('skips with the recorded reason when contactChannels is absent (core-harm — AC3)', () => {
    expect(resolvePushTarget(undefined)).toEqual({
      skipped: true,
      reason: NO_TOKEN_REGISTERED_REASON,
    });
  });

  it('excludes an entry marked valid:false and skips (AC4)', () => {
    const result = resolvePushTarget([
      { channel: 'PUSH', token: 'tok-1', platform: 'APNS', valid: false },
    ]);
    expect(result).toEqual({ skipped: true, reason: NO_TOKEN_REGISTERED_REASON });
  });

  it('returns the token and platform for a valid PUSH entry (AC1/AC2)', () => {
    const result = resolvePushTarget([
      { channel: 'SMS', token: '+15551234567' },
      { channel: 'PUSH', token: 'tok-1', platform: 'APNS', valid: true },
    ]);
    expect(result).toEqual({ skipped: false, token: 'tok-1', platform: 'APNS' });
  });

  it('treats a PUSH entry with valid omitted as valid (default-true)', () => {
    const result = resolvePushTarget([{ channel: 'PUSH', token: 'tok-1', platform: 'FCM' }]);
    expect(result).toEqual({ skipped: false, token: 'tok-1', platform: 'FCM' });
  });
});
