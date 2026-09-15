import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.ALERTING_TABLE_NAME = 'alerting-table';
  process.env.PUSH_PROVIDER_ENDPOINT_URL = 'https://push.example';
  process.env.PUSH_PROVIDER_SECRET_ID = 'push-secret';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function sqsEvent(channel: string, memberId = 'mbr-1'): SQSEvent {
  return {
    Records: [
      {
        messageId: 'msg-1',
        body: JSON.stringify({
          eventId: 'evt-1',
          eventTime: '2026-09-06T00:00:00Z',
          eventType: 'alerting.dispatch.normalized',
          source: 'alert-fanout-service',
          correlationId: 'dispatch-1',
          schemaVersion: '1.0',
          payload: {
            deptId: 'NICHOLS',
            dispatchId: 'dispatch-1',
            memberId,
            channel,
            channelTier: 'primary',
            toneSequence: 1,
            incidentType: 'structure-fire',
            address: '12 Main St',
          },
        }),
      },
    ],
  } as unknown as SQSEvent;
}

function mockDeps(
  sendViaHttpProvider: ReturnType<typeof vi.fn>,
  send: ReturnType<typeof vi.fn>,
): void {
  vi.doMock('../httpProviderAdapter.js', () => ({ sendViaHttpProvider }));
  vi.doMock('../../eligibility/dynamoClient.js', () => ({
    createDynamoClient: () => ({ send }),
    readAlertingConfig: () => ({ tableName: 'alerting-table' }),
  }));
}

describe('push channel worker (entrypoint-test obligation)', () => {
  it('rethrows on a malformed record and never calls the provider', async () => {
    const sendViaHttpProvider = vi.fn();
    const send = vi.fn();
    mockDeps(sendViaHttpProvider, send);
    const { handler } = await import('./worker.js');

    await expect(
      handler({ Records: [{ messageId: 'msg-1', body: 'not-json' }] } as unknown as SQSEvent),
    ).rejects.toThrow();
    expect(sendViaHttpProvider).not.toHaveBeenCalled();
  });

  it('rejects an envelope routed to this worker carrying a different channel', async () => {
    const sendViaHttpProvider = vi.fn();
    const send = vi.fn();
    mockDeps(sendViaHttpProvider, send);
    const { handler } = await import('./worker.js');

    await expect(handler(sqsEvent('sms'))).rejects.toThrow(/channel=sms/);
    expect(sendViaHttpProvider).not.toHaveBeenCalled();
  });

  it('resolves the target from the eligibility snapshot and sends via the push provider on the happy path', async () => {
    const sendViaHttpProvider = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({
          Item: { contactChannels: [{ channel: 'PUSH', token: 'tok-1', valid: true }] },
        });
      }
      return Promise.resolve({});
    });
    mockDeps(sendViaHttpProvider, send);
    const { handler } = await import('./worker.js');

    await handler(sqsEvent('push'));

    expect(sendViaHttpProvider).toHaveBeenCalledWith(
      'push',
      'tok-1',
      'structure-fire — 12 Main St',
      process.env,
    );
  });

  it('logs a structured entry with correlationId/memberId/channel and rethrows when the eligibility read fails', async () => {
    const sendViaHttpProvider = vi.fn();
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.reject(new Error('DynamoDB throttled'));
      }
      return Promise.resolve({});
    });
    mockDeps(sendViaHttpProvider, send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./worker.js');

    await expect(handler(sqsEvent('push'))).rejects.toThrow('DynamoDB throttled');

    expect(sendViaHttpProvider).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('alerting.channel.eligibility_read_failed'),
    );
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.correlationId).toBe('dispatch-1');
    expect(logged.memberId).toBe('mbr-1');
    expect(logged.channel).toBe('push');
    errorSpy.mockRestore();
  });
});
