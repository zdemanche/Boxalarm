import { describe, expect, it } from 'vitest';
import { deriveFanOutKey, deriveMessageDeduplicationId } from './idempotencyKey.js';

describe('deriveFanOutKey', () => {
  it('is pure and deterministic for the same input', () => {
    const input = {
      dispatchId: 'd-1',
      toneSequence: 1,
      memberId: 'mbr-1',
      channel: 'push',
    } as const;
    expect(deriveFanOutKey(input)).toEqual(deriveFanOutKey(input));
  });

  it('keys the idempotencyKey and sk on dispatchId, toneSequence, memberId, and channel', () => {
    const result = deriveFanOutKey({
      dispatchId: 'd-1',
      toneSequence: 1,
      memberId: 'mbr-1',
      channel: 'push',
    });
    expect(result).toEqual({
      sk: 'RECEIPT#mbr-1#push#1',
      idempotencyKey: 'd-1#1#mbr-1#push',
    });
  });

  it('produces two distinct keys for push and sms on the same dispatch/member/tone (AC1/AC3 core-harm)', () => {
    const push = deriveFanOutKey({
      dispatchId: 'd-1',
      toneSequence: 1,
      memberId: 'mbr-1',
      channel: 'push',
    });
    const sms = deriveFanOutKey({
      dispatchId: 'd-1',
      toneSequence: 1,
      memberId: 'mbr-1',
      channel: 'sms',
    });
    expect(push.idempotencyKey).not.toBe(sms.idempotencyKey);
    expect(push.sk).not.toBe(sms.sk);
  });

  it('never accepts a channelTier input — the key type has no such field (AC3 regression guard)', () => {
    const input = {
      dispatchId: 'd-1',
      toneSequence: 1,
      memberId: 'mbr-1',
      channel: 'push',
    } as const;
    expect(Object.keys(input)).not.toContain('channelTier');
    expect(deriveFanOutKey(input).idempotencyKey).not.toContain('primary');
    expect(deriveFanOutKey(input).idempotencyKey).not.toContain('escalation');
  });

  it('produces a distinct key per tone so a tone-2 re-tone does not collide with tone 1', () => {
    const tone1 = deriveFanOutKey({
      dispatchId: 'd-1',
      toneSequence: 1,
      memberId: 'mbr-1',
      channel: 'push',
    });
    const tone2 = deriveFanOutKey({
      dispatchId: 'd-1',
      toneSequence: 2,
      memberId: 'mbr-1',
      channel: 'push',
    });
    expect(tone1.idempotencyKey).not.toBe(tone2.idempotencyKey);
  });
});

describe('deriveMessageDeduplicationId', () => {
  it('is pure and deterministic for the same input', () => {
    const input = {
      dispatchId: 'd-1',
      toneSequence: 1,
      memberId: 'mbr-1',
      channel: 'push',
    } as const;
    expect(deriveMessageDeduplicationId(input)).toBe(deriveMessageDeduplicationId(input));
  });

  it('differs between push and sms for the same dispatch/member/tone', () => {
    const push = deriveMessageDeduplicationId({
      dispatchId: 'd-1',
      toneSequence: 1,
      memberId: 'mbr-1',
      channel: 'push',
    });
    const sms = deriveMessageDeduplicationId({
      dispatchId: 'd-1',
      toneSequence: 1,
      memberId: 'mbr-1',
      channel: 'sms',
    });
    expect(push).not.toBe(sms);
  });
});
