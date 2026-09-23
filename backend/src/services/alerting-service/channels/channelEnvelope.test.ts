import { describe, expect, it } from 'vitest';
import { parseChannelEnvelope, resolveChannelTarget } from './channelEnvelope.js';

function body(payload: Record<string, unknown>): string {
  return JSON.stringify({
    eventId: 'evt-1',
    eventTime: '2026-09-06T00:00:00Z',
    eventType: 'alerting.dispatch.normalized',
    source: 'alert-fanout-service',
    correlationId: 'dispatch-1',
    schemaVersion: '1.0',
    payload,
  });
}

const validPayload = {
  deptId: 'NICHOLS',
  dispatchId: 'dispatch-1',
  memberId: 'mbr-1',
  channel: 'push',
  toneSequence: 1,
  incidentType: 'structure-fire',
  address: '12 Main St',
};

describe('parseChannelEnvelope', () => {
  it('parses a valid alerting.dispatch.normalized envelope for the expected channel', () => {
    expect(parseChannelEnvelope(body(validPayload), 'push')).toEqual(validPayload);
  });

  it('throws when the body is empty', () => {
    expect(() => parseChannelEnvelope('', 'push')).toThrow();
  });

  it('throws when channel is absent', () => {
    const rest: Record<string, unknown> = { ...validPayload };
    delete rest.channel;
    expect(() => parseChannelEnvelope(body(rest), 'push')).toThrow(
      'alerting channel envelope failed shape validation',
    );
  });

  it('throws when channel does not match the routed worker (defends the channel/channelTier misroute defect)', () => {
    expect(() => parseChannelEnvelope(body(validPayload), 'sms')).toThrow(/channel=push/);
  });

  it('throws when toneSequence is wrong-typed', () => {
    expect(() =>
      parseChannelEnvelope(body({ ...validPayload, toneSequence: '2' }), 'push'),
    ).toThrow('alerting channel envelope failed shape validation');
  });

  it('throws when toneSequence is NaN', () => {
    expect(() =>
      parseChannelEnvelope(body({ ...validPayload, toneSequence: Number.NaN }), 'push'),
    ).toThrow('alerting channel envelope failed shape validation');
  });

  it('throws when memberId contains the "#" pk-scoping delimiter (P1 — idempotency-key/receipt-sk collision guard)', () => {
    expect(() =>
      parseChannelEnvelope(body({ ...validPayload, memberId: 'mbr#1' }), 'push'),
    ).toThrow(/memberId/);
  });

  it('throws when dispatchId contains the "#" pk-scoping delimiter', () => {
    expect(() =>
      parseChannelEnvelope(body({ ...validPayload, dispatchId: 'dispatch#1' }), 'push'),
    ).toThrow(/dispatchId/);
  });
});

describe('resolveChannelTarget', () => {
  it('resolves the push token from contactChannels', () => {
    expect(
      resolveChannelTarget('push', [{ channel: 'PUSH', token: 'tok-1', valid: true }]),
    ).toEqual({ skipped: false, target: 'tok-1' });
  });

  it('resolves the sms phone number from contactChannels', () => {
    expect(
      resolveChannelTarget('sms', [{ channel: 'SMS', phoneNumber: '+12035550100', valid: true }]),
    ).toEqual({ skipped: false, target: '+12035550100' });
  });

  it('resolves the voice phone number from contactChannels', () => {
    expect(
      resolveChannelTarget('voice', [
        { channel: 'VOICE', phoneNumber: '+12035550100', valid: true },
      ]),
    ).toEqual({ skipped: false, target: '+12035550100' });
  });

  it('skips when contactChannels is empty/absent, without attempting a send', () => {
    expect(resolveChannelTarget('push', undefined)).toEqual({
      skipped: true,
      reason: 'push: no target registered',
    });
    expect(resolveChannelTarget('sms', [])).toEqual({
      skipped: true,
      reason: 'sms: no target registered',
    });
  });

  it('skips when the matching entry is marked invalid', () => {
    expect(
      resolveChannelTarget('voice', [
        { channel: 'VOICE', phoneNumber: '+12035550100', valid: false },
      ]),
    ).toEqual({ skipped: true, reason: 'voice: no target registered' });
  });
});
