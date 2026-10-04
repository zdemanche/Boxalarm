import { PushCredentialsUnavailableError } from '@boxalarm/push-transport';
import type { SQSEvent } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const APNS_TOKEN = 'a'.repeat(64);
const ENV = {
  PLATFORM_SERVICE_TABLE_NAME: 'boxalarm-dev-platform-service',
  APNS_SECRET_ID: 'boxalarm-dev-alerting-push-apns-credentials',
  APNS_SANDBOX_SECRET_ID: 'boxalarm-dev-alerting-push-apns-sandbox-credentials',
  FCM_SECRET_ID: 'boxalarm-dev-alerting-push-fcm-credentials',
};

function message(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    channelId: 'apparatus-defect',
    memberId: 'MBR-1',
    deptId: 'NICHOLS',
    notificationCategory: 'apparatus-defect',
    category: 'digest',
    title: 'Apparatus defect',
    body: 'Engine 1 reported out of service',
    correlationId: 'corr-1',
    ...overrides,
  });
}

function sqsEvent(...bodies: string[]): SQSEvent {
  return {
    Records: bodies.map((body, index) => ({ messageId: `msg-${index + 1}`, body })),
  } as SQSEvent;
}

interface FakeDdb {
  send: ReturnType<typeof vi.fn>;
}

function memberRow(contactChannels: unknown[]): Record<string, unknown> {
  return {
    pk: 'DEPT#NICHOLS#MEMBER#MBR-1',
    sk: 'METADATA',
    memberId: 'MBR-1',
    updatedAt: 1_000,
    contactChannels,
  };
}

function fakeDdb(row: Record<string, unknown> | undefined): FakeDdb {
  return {
    send: vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: row });
      }
      return Promise.resolve({});
    }),
  };
}

async function loadWorker(ddb: FakeDdb, deps: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock('../dynamoClient.js', () => ({
    createDynamoClient: () => ddb,
    readNotificationConfig: (env: NodeJS.ProcessEnv) => ({
      tableName: env.PLATFORM_SERVICE_TABLE_NAME,
    }),
  }));
  const { createPushWorkerHandler } = await import('./worker.js');
  return createPushWorkerHandler({ secretsClient: {} as never, ...deps });
}

beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) {
    vi.stubEnv(key, value);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('notification push worker (M7)', () => {
  it('sends an APNs device a non-critical push with isTest hard-coded false', async () => {
    const sendApns = vi.fn().mockResolvedValue({ outcome: 'sent' });
    const ddb = fakeDdb(memberRow([{ channel: 'PUSH', platform: 'APNS', token: APNS_TOKEN }]));
    const handler = await loadWorker(ddb, { sendApns });

    const result = await handler(sqsEvent(message()));

    expect(result.batchItemFailures).toEqual([]);
    expect(sendApns).toHaveBeenCalledTimes(1);
    const [apnsMessage, options] = sendApns.mock.calls[0] as [
      {
        token: string;
        headers: Record<string, string>;
        buildPayload: () => Record<string, unknown>;
      },
      { isTest: boolean; sandboxSecret: boolean; secretId: string },
    ];
    expect(apnsMessage.token).toBe(APNS_TOKEN);
    expect(options.isTest).toBe(false);
    expect(options.sandboxSecret).toBe(false);
    expect(options.secretId).toBe(ENV.APNS_SECRET_ID);
    const payload = apnsMessage.buildPayload();
    const aps = payload.aps as Record<string, unknown>;
    expect(aps['interruption-level']).toBe('active');
    expect(aps.category).toBeUndefined();
    expect(payload.category).toBe('digest');
    expect(apnsMessage.headers['apns-push-type']).toBe('alert');
  });

  it('uses the sandbox APNs secret for a development-signed device', async () => {
    const sendApns = vi.fn().mockResolvedValue({ outcome: 'sent' });
    const ddb = fakeDdb(
      memberRow([
        { channel: 'PUSH', platform: 'APNS', token: APNS_TOKEN, apnsEnvironment: 'development' },
      ]),
    );
    const handler = await loadWorker(ddb, { sendApns });

    await handler(sqsEvent(message()));

    const options = sendApns.mock.calls[0]?.[1] as { secretId: string; sandboxSecret: boolean };
    expect(options.secretId).toBe(ENV.APNS_SANDBOX_SECRET_ID);
    expect(options.sandboxSecret).toBe(true);
  });

  it('sends an FCM device a NORMAL-priority data-only message on the digest route', async () => {
    const sendFcm = vi.fn().mockResolvedValue({ outcome: 'sent' });
    const ddb = fakeDdb(memberRow([{ channel: 'PUSH', platform: 'FCM', token: 'fcm-token' }]));
    const handler = await loadWorker(ddb, { sendFcm });

    const result = await handler(sqsEvent(message()));

    expect(result.batchItemFailures).toEqual([]);
    const [fcmMessage, options] = sendFcm.mock.calls[0] as [
      { buildRequest: () => Record<string, unknown> },
      { isTest: boolean; secretId: string },
    ];
    expect(options.isTest).toBe(false);
    expect(options.secretId).toBe(ENV.FCM_SECRET_ID);
    const request = fcmMessage.buildRequest();
    expect(request.validate_only).toBeUndefined();
    const fcm = request.message as {
      token: string;
      notification?: unknown;
      android: { priority: string };
      data: Record<string, string>;
    };
    expect(fcm.token).toBe('fcm-token');
    expect(fcm.notification).toBeUndefined();
    expect(fcm.android.priority).toBe('NORMAL');
    expect(fcm.data.category).toBe('digest');
  });

  it('skips invalid and non-push channels and succeeds with none left', async () => {
    const sendApns = vi.fn();
    const sendFcm = vi.fn();
    const ddb = fakeDdb(
      memberRow([
        { channel: 'EMAIL', token: 'nope' },
        { channel: 'PUSH', platform: 'FCM', token: 'dead-token', valid: false },
        { channel: 'PUSH', platform: 'FCM' },
      ]),
    );
    const handler = await loadWorker(ddb, { sendApns, sendFcm });

    const result = await handler(sqsEvent(message()));

    expect(result.batchItemFailures).toEqual([]);
    expect(sendApns).not.toHaveBeenCalled();
    expect(sendFcm).not.toHaveBeenCalled();
  });

  it('an invalid token is counted and skipped — the member row is NEVER written (MAJOR-1)', async () => {
    const sendFcm = vi
      .fn()
      .mockResolvedValue({ outcome: 'invalid_token', reason: 'FCM_UNREGISTERED' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const row = memberRow([{ channel: 'PUSH', platform: 'FCM', token: 'dead-token-123456789' }]);
    const commands: string[] = [];
    const ddb: FakeDdb = {
      send: vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
        commands.push(command.constructor.name);
        if (command.constructor.name === 'GetCommand') {
          return Promise.resolve({ Item: row });
        }
        return Promise.resolve({});
      }),
    };
    const handler = await loadWorker(ddb, { sendFcm });

    const result = await handler(sqsEvent(message()));

    // Not a batch failure (a redelivery cannot revive the token), and not a write: token
    // validity on the personnel row feeds the alerting snapshot and is the guarded alerting
    // worker's alone to change. Only reads happened.
    expect(result.batchItemFailures).toEqual([]);
    expect(commands).toEqual(['GetCommand']);
    // Counted (PushTokenInvalid, alarmed in infra) and logged with the device suffix only.
    const logged = errorSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .find((entry) => entry.event === 'notification.push.token_invalid');
    expect(logged).toMatchObject({ reason: 'FCM_UNREGISTERED', tokenSuffix: '23456789' });
    expect(JSON.stringify(logged)).not.toContain('dead-token-123456789');
    // The EMF metric the infra alarm watches, with the Reason dimension.
    const metric = logSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('"PushTokenInvalid":1'));
    expect(metric).toBeDefined();
    expect(metric).toContain('"Reason":"FCM_UNREGISTERED"');
  });

  it('succeeds without sending when the member has no devices', async () => {
    const sendApns = vi.fn();
    const ddb = fakeDdb(memberRow([]));
    const handler = await loadWorker(ddb, { sendApns });

    const result = await handler(sqsEvent(message()));

    expect(result.batchItemFailures).toEqual([]);
    expect(sendApns).not.toHaveBeenCalled();
  });

  it('reports a batch item failure for a malformed message, isolating siblings', async () => {
    const sendFcm = vi.fn().mockResolvedValue({ outcome: 'sent' });
    const ddb = fakeDdb(memberRow([{ channel: 'PUSH', platform: 'FCM', token: 'fcm-token' }]));
    const handler = await loadWorker(ddb, { sendFcm });

    const result = await handler(sqsEvent('{"not":"a push message"}', message()));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'msg-1' }]);
    expect(sendFcm).toHaveBeenCalledTimes(1);
  });

  it('reports a batch item failure when the transport throws (retry, then DLQ)', async () => {
    const sendFcm = vi.fn().mockRejectedValue(new Error('FCM responded 503 UNKNOWN'));
    const ddb = fakeDdb(memberRow([{ channel: 'PUSH', platform: 'FCM', token: 'fcm-token' }]));
    const handler = await loadWorker(ddb, { sendFcm });

    const result = await handler(sqsEvent(message()));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'msg-1' }]);
  });

  it('treats a non-transient missing secret as terminal for the device, not a redelivery', async () => {
    const sendApns = vi
      .fn()
      .mockRejectedValue(
        new PushCredentialsUnavailableError(
          'APNS_SANDBOX_SECRET_ID is required and was not set',
          'APNS_SANDBOX_SECRET_ID',
        ),
      );
    const ddb = fakeDdb(
      memberRow([
        { channel: 'PUSH', platform: 'APNS', token: APNS_TOKEN, apnsEnvironment: 'development' },
      ]),
    );
    const handler = await loadWorker(ddb, { sendApns });

    const result = await handler(sqsEvent(message()));

    expect(result.batchItemFailures).toEqual([]);
  });

  it('unwraps a non-raw SNS envelope rather than dropping it', async () => {
    const sendFcm = vi.fn().mockResolvedValue({ outcome: 'sent' });
    const ddb = fakeDdb(memberRow([{ channel: 'PUSH', platform: 'FCM', token: 'fcm-token' }]));
    const handler = await loadWorker(ddb, { sendFcm });

    const result = await handler(
      sqsEvent(JSON.stringify({ Type: 'Notification', Message: message() })),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(sendFcm).toHaveBeenCalledTimes(1);
  });
});
