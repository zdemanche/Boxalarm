import { describe, expect, it } from 'vitest';
import { phoneContactEntries, pushEntriesFrom } from '../eligibility/contactProjection.js';
import { resolvePushTarget, resolveSmsTarget } from '../eligibility/resolvePushTarget.js';
import { resolveChannelTarget } from './channelEnvelope.js';

/**
 * The producers (fan-out, tone evaluator) decide which channels to publish from the
 * eligibility snapshot, and the channel worker resolves the send target from the same
 * snapshot. If they disagree on the contact shape the producer publishes and the worker
 * silently finds no target - the recurring SMS-never-sends defect (#12). This ties the
 * snapshot writer's shape (eligibility/contactProjection.ts, the deployed
 * personnel.member.updated consumer's projection) to both readers.
 */
describe('contact channel shape: snapshot writer ↔ producers ↔ channel worker', () => {
  const phone = '+12035550100';
  const [writerSms, writerVoice] = phoneContactEntries(phone);
  const registeredPush = { channel: 'PUSH', platform: 'ios', token: 'tok-1', valid: true };

  it('the SMS entry the phone projection writes is paged by the producer AND sent by the worker', () => {
    expect(resolveSmsTarget([writerSms!])).toEqual({ skipped: false, number: phone });
    expect(resolveChannelTarget('sms', [writerSms!])).toEqual({ skipped: false, target: phone });
  });

  it('the VOICE entry the phone projection writes is dialled by the voice worker', () => {
    expect(resolveChannelTarget('voice', [writerVoice!])).toEqual({
      skipped: false,
      target: phone,
    });
    expect(resolveChannelTarget('voice', phoneContactEntries(phone))).toEqual({
      skipped: false,
      target: phone,
    });
  });

  it('voice escalation falls back to the SMS phone when no VOICE entry exists', () => {
    expect(resolveChannelTarget('voice', [writerSms!])).toEqual({ skipped: false, target: phone });
  });

  it('the legacy { channel: "sms", token } shape still resolves the same on both sides', () => {
    const legacy = { channel: 'sms', token: phone };
    expect(resolveSmsTarget([legacy])).toEqual({ skipped: false, number: phone });
    expect(resolveChannelTarget('sms', [legacy])).toEqual({ skipped: false, target: phone });
  });

  it('a registered push token (as the projection keeps it) resolves on both sides', () => {
    const [kept] = pushEntriesFrom([registeredPush, writerSms]);
    expect(kept).toEqual(registeredPush);
    expect(resolvePushTarget([kept!])).toMatchObject({ skipped: false, token: 'tok-1' });
    expect(resolveChannelTarget('push', [kept!])).toEqual({ skipped: false, target: 'tok-1' });
  });

  // Review MINOR-R8: the producer demanded exact-case 'PUSH' and a platform the worker never
  // needed - the producer-stricter direction, where the page is never published at all.
  it.each([
    ['lowercase channel', { channel: 'push', token: 'tok-1' }],
    ['no platform', { channel: 'PUSH', token: 'tok-1' }],
  ])('a push entry with %s resolves on both sides', (_label, entry) => {
    expect(resolvePushTarget([entry])).toMatchObject({ skipped: false, token: 'tok-1' });
    expect(resolveChannelTarget('push', [entry])).toEqual({ skipped: false, target: 'tok-1' });
  });

  it('a malformed entry is ignored by both sides, never thrown on', () => {
    const malformed = [{ token: 'x' }, null, { channel: 7 }] as unknown as Parameters<
      typeof resolveSmsTarget
    >[0];
    const contacts = [...(malformed ?? []), writerSms!];
    expect(resolveSmsTarget(contacts)).toEqual({ skipped: false, number: phone });
    expect(resolvePushTarget(contacts).skipped).toBe(true);
    expect(resolveChannelTarget('sms', contacts)).toEqual({ skipped: false, target: phone });
  });

  it('an invalid entry is skipped by both sides', () => {
    const invalid = { ...writerSms!, valid: false };
    expect(resolveSmsTarget([invalid]).skipped).toBe(true);
    expect(resolveChannelTarget('sms', [invalid]).skipped).toBe(true);
  });
});
