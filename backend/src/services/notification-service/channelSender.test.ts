import { describe, expect, it, vi } from 'vitest';
import type { SNSClient } from '@aws-sdk/client-sns';
import type { SESv2Client } from '@aws-sdk/client-sesv2';
import { CERT_EXPIRY_DIGEST_CHANNEL_ID, sendEmailDigest, sendPushDigest } from './channelSender.js';

const ITEMS = [{ certId: 'CERT-1', expiryDate: '2027-01-10' }];
const ENV = {
  NOTIFICATION_PUSH_TOPIC_ARN: 'arn:aws:sns:us-east-1:111:cert-expiry-digest',
  NOTIFICATION_SES_FROM_ADDRESS: 'notifications@boxalarm.dev',
};

describe('sendPushDigest', () => {
  it('publishes exactly once, carrying channelId=cert-expiry-digest distinct from any alerting literal', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as SNSClient;

    await sendPushDigest(ENV, { memberId: 'MBR-1' }, ITEMS, 'corr-1', client);

    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0]?.[0] as { input: { Message: string } };
    const message = JSON.parse(call.input.Message) as { channelId: string };
    expect(message.channelId).toBe(CERT_EXPIRY_DIGEST_CHANNEL_ID);
    expect(['push', 'sms', 'voice']).not.toContain(message.channelId);
  });

  it('throws (fail-closed) when NOTIFICATION_PUSH_TOPIC_ARN is not configured', async () => {
    const send = vi.fn();
    const client = { send } as unknown as SNSClient;
    await expect(
      sendPushDigest({}, { memberId: 'MBR-1' }, ITEMS, 'corr-1', client),
    ).rejects.toThrow('NOTIFICATION_PUSH_TOPIC_ARN');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('sendEmailDigest', () => {
  it('sends exactly one email when the recipient has an address on file', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as SESv2Client;

    await sendEmailDigest(
      ENV,
      { memberId: 'MBR-1', email: 'mbr1@example.com' },
      ITEMS,
      'corr-1',
      client,
    );

    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0]?.[0] as { input: { Destination: { ToAddresses: string[] } } };
    expect(call.input.Destination.ToAddresses).toEqual(['mbr1@example.com']);
  });

  it('no-ops without an email address rather than sending to an unknown destination', async () => {
    const send = vi.fn();
    const client = { send } as unknown as SESv2Client;

    await sendEmailDigest(ENV, { memberId: 'MBR-1' }, ITEMS, 'corr-1', client);

    expect(send).not.toHaveBeenCalled();
  });

  it('throws (fail-closed) when NOTIFICATION_SES_FROM_ADDRESS is not configured', async () => {
    const send = vi.fn();
    const client = { send } as unknown as SESv2Client;
    await expect(
      sendEmailDigest(
        {},
        { memberId: 'MBR-1', email: 'mbr1@example.com' },
        ITEMS,
        'corr-1',
        client,
      ),
    ).rejects.toThrow('NOTIFICATION_SES_FROM_ADDRESS');
    expect(send).not.toHaveBeenCalled();
  });
});
