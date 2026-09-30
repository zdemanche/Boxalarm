import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';
import type { ContactChannelEntry } from './pushDevices.js';

interface SentCommand {
  constructor: { name: string };
  input: {
    Key?: { pk: string };
    IndexName?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
    TransactItems?: [
      {
        Update: {
          Key: { pk: string };
          ExpressionAttributeValues: { ':cc': ContactChannelEntry[] };
        };
      },
      { Put: { Item: { payload: Record<string, unknown> } } },
    ];
  };
}

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'mbr-102',
  deptId: 'NICHOLS',
  'cognito:groups': 'member',
};

function buildEvent(memberId: string, body: unknown): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/personnel/members/{memberId}/push-tokens',
    rawPath: `/api/v1/personnel/members/${memberId}/push-tokens`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: { memberId },
    body: JSON.stringify(body),
    requestContext: { authorizer: { lambda: PRINCIPAL } },
  } as unknown as GuardEvent;
}

describe('parseRegisterBody', () => {
  it('throws when token is absent', async () => {
    const { parseRegisterBody } = await import('./registerToken.js');
    expect(() => parseRegisterBody(JSON.stringify({ platform: 'APNS' }))).toThrow(
      'token is required',
    );
  });

  it('throws when token is an empty string', async () => {
    const { parseRegisterBody } = await import('./registerToken.js');
    expect(() => parseRegisterBody(JSON.stringify({ platform: 'APNS', token: '' }))).toThrow(
      'token is required',
    );
  });

  it('throws when platform is wrong-typed (a number)', async () => {
    const { parseRegisterBody } = await import('./registerToken.js');
    expect(() => parseRegisterBody(JSON.stringify({ platform: 1, token: 'tok' }))).toThrow(
      'platform is required',
    );
  });

  it('parses an optional deviceId and rejects an unusable one', async () => {
    const { parseRegisterBody } = await import('./registerToken.js');
    expect(
      parseRegisterBody(JSON.stringify({ platform: 'APNS', token: 'tok-1', deviceId: 'dev-1' })),
    ).toEqual({ platform: 'APNS', token: 'tok-1', deviceId: 'dev-1' });
    expect(() =>
      parseRegisterBody(JSON.stringify({ platform: 'APNS', token: 'tok-1', deviceId: 'a#b' })),
    ).toThrow('deviceId');
  });

  // Review MAJOR-2: the APNs environment travels with the token so the worker uses the
  // matching host; omitted means production, and it is ignored for FCM.
  it('parses an optional APNs environment and rejects an unknown one', async () => {
    const { parseRegisterBody } = await import('./registerToken.js');
    expect(
      parseRegisterBody(
        JSON.stringify({ platform: 'APNS', token: 't', apnsEnvironment: 'development' }),
      ),
    ).toEqual({ platform: 'APNS', token: 't', apnsEnvironment: 'development' });
    expect(
      parseRegisterBody(
        JSON.stringify({ platform: 'FCM', token: 't', apnsEnvironment: 'production' }),
      ),
    ).toEqual({ platform: 'FCM', token: 't' });
    expect(() =>
      parseRegisterBody(
        JSON.stringify({ platform: 'APNS', token: 't', apnsEnvironment: 'sandbox' }),
      ),
    ).toThrow('apnsEnvironment');
  });

  it('parses a valid body', async () => {
    const { parseRegisterBody } = await import('./registerToken.js');
    expect(parseRegisterBody(JSON.stringify({ platform: 'FCM', token: 'tok-1' }))).toEqual({
      platform: 'FCM',
      token: 'tok-1',
    });
  });
});

describe('registerToken handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PERSONNEL_TABLE_NAME = 'personnel-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 400 problem+json when body.token is absent/empty (AC-matrix)', async () => {
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return {
        ...actual,
        withAuthorization: (inner: unknown) => inner,
      };
    });
    const { handler } = await import('./registerToken.js');
    const event = buildEvent('mbr-102', { platform: 'APNS' });
    const result = await (
      handler as unknown as (
        e: GuardEvent,
        p: CedarPrincipalContext,
      ) => Promise<{
        statusCode: number;
      }>
    )(event, PRINCIPAL);
    expect(result.statusCode).toBe(400);
    vi.doUnmock('@boxalarm/authz');
  });

  it('registers a token and writes MEMBER + OUTBOX_ENTRY via one TransactWriteItems call (AC1)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: { pk: 'DEPT#NICHOLS#MEMBER#mbr-102', sk: 'METADATA' } });
      }
      return Promise.resolve({});
    });
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization: (inner: unknown) => inner };
    });

    const { handler } = await import('./registerToken.js');
    const event = buildEvent('mbr-102', { platform: 'APNS', token: 'tok-abc' });
    const result = await (
      handler as unknown as (
        e: GuardEvent,
        p: CedarPrincipalContext,
      ) => Promise<{
        statusCode: number;
      }>
    )(event, PRINCIPAL);

    expect(result.statusCode).toBe(200);
    // Get + transaction for the member's own entry, then the department query that takes the
    // installation off anyone else still holding it (M3).
    expect(send).toHaveBeenCalledTimes(3);
    expect((send.mock.calls[2]?.[0] as { constructor: { name: string } }).constructor.name).toBe(
      'QueryCommand',
    );
    const transactCall = send.mock.calls[1]?.[0] as {
      input: { TransactItems: [{ Update: unknown }, { Put: { Item: Record<string, unknown> } }] };
    };
    expect(transactCall.input.TransactItems).toHaveLength(2);
    const outboxItem = transactCall.input.TransactItems[1].Put.Item;
    expect(outboxItem.eventType).toBe('personnel.member.updated');
    expect(outboxItem.pk).toBe('DEPT#NICHOLS#OUTBOX#mbr-102');

    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });

  it('returns 404 problem+json when the MEMBER item is absent (AC-matrix)', async () => {
    const send = vi.fn().mockResolvedValue({ Item: undefined });
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization: (inner: unknown) => inner };
    });

    const { handler } = await import('./registerToken.js');
    const event = buildEvent('mbr-102', { platform: 'APNS', token: 'tok-abc' });
    const result = await (
      handler as unknown as (
        e: GuardEvent,
        p: CedarPrincipalContext,
      ) => Promise<{
        statusCode: number;
      }>
    )(event, PRINCIPAL);

    expect(result.statusCode).toBe(404);
    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });

  it('propagates (does not swallow) a DynamoDB TransactWriteItems throw that is not a conditional-check failure (AC-matrix)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: { pk: 'DEPT#NICHOLS#MEMBER#mbr-102', sk: 'METADATA' } });
      }
      return Promise.reject(new Error('ProvisionedThroughputExceededException'));
    });
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization: (inner: unknown) => inner };
    });

    const { handler } = await import('./registerToken.js');
    const event = buildEvent('mbr-102', { platform: 'APNS', token: 'tok-abc' });
    await expect(
      (handler as unknown as (e: GuardEvent, p: CedarPrincipalContext) => Promise<unknown>)(
        event,
        PRINCIPAL,
      ),
    ).rejects.toThrow('ProvisionedThroughputExceededException');

    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });

  it('rethrows (does not map to 404) a TransactionCanceledException whose cancellation reason is not ConditionalCheckFailed (P12 regression)', async () => {
    const { TransactionCanceledException } = await import('@aws-sdk/client-dynamodb');
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: { pk: 'DEPT#NICHOLS#MEMBER#mbr-102', sk: 'METADATA' } });
      }
      return Promise.reject(
        new TransactionCanceledException({
          message: 'cancelled',
          CancellationReasons: [{ Code: 'TransactionConflict' }],
          $metadata: {},
        }),
      );
    });
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization: (inner: unknown) => inner };
    });

    const { handler } = await import('./registerToken.js');
    const event = buildEvent('mbr-102', { platform: 'APNS', token: 'tok-abc' });
    await expect(
      (handler as unknown as (e: GuardEvent, p: CedarPrincipalContext) => Promise<unknown>)(
        event,
        PRINCIPAL,
      ),
    ).rejects.toThrow('cancelled');

    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });

  it('rotates: a second register call overwrites the stale token, never appending a duplicate PUSH entry (AC2)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({
          Item: {
            pk: 'DEPT#NICHOLS#MEMBER#mbr-102',
            sk: 'METADATA',
            contactChannels: [
              { channel: 'PUSH', platform: 'APNS', token: 'stale-tok', valid: true },
            ],
          },
        });
      }
      return Promise.resolve({});
    });
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization: (inner: unknown) => inner };
    });

    const { handler } = await import('./registerToken.js');
    const event = buildEvent('mbr-102', { platform: 'FCM', token: 'fresh-tok' });
    await (handler as unknown as (e: GuardEvent, p: CedarPrincipalContext) => Promise<unknown>)(
      event,
      PRINCIPAL,
    );

    const transactCall = send.mock.calls[1]?.[0] as {
      input: { TransactItems: [{ Update: { ExpressionAttributeValues: { ':cc': unknown[] } } }] };
    };
    const contactChannels = transactCall.input.TransactItems[0].Update.ExpressionAttributeValues[
      ':cc'
    ] as { token: string }[];
    expect(contactChannels).toHaveLength(1);
    expect(contactChannels[0]?.token).toBe('fresh-tok');

    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });

  it('never logs the raw token value', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: { pk: 'DEPT#NICHOLS#MEMBER#mbr-102', sk: 'METADATA' } });
      }
      return Promise.resolve({});
    });
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization: (inner: unknown) => inner };
    });

    const { handler } = await import('./registerToken.js');
    const secretToken = 'super-secret-device-token-value';
    const event = buildEvent('mbr-102', { platform: 'APNS', token: secretToken });
    await (handler as unknown as (e: GuardEvent, p: CedarPrincipalContext) => Promise<unknown>)(
      event,
      PRINCIPAL,
    );

    for (const call of logSpy.mock.calls) {
      expect(call[0] as string).not.toContain(secretToken);
    }

    logSpy.mockRestore();
    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });

  it('returns 403 without touching DynamoDB when the path member is not the caller', async () => {
    const send = vi.fn();
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization: (inner: unknown) => inner };
    });

    const { handler } = await import('./registerToken.js');
    const event = buildEvent('mbr-someone-else', { platform: 'APNS', token: 'tok-abc' });
    const result = await (
      handler as unknown as (
        e: GuardEvent,
        p: CedarPrincipalContext,
      ) => Promise<{ statusCode: number }>
    )(event, PRINCIPAL);

    expect(result.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });

  // Multi-device (design review item 4): signing in on a tablet used to replace the phone's
  // PUSH entry, silently ending the phone's pages.
  it('adds a second device instead of replacing the first', async () => {
    const phone = {
      channel: 'PUSH',
      platform: 'APNS',
      token: 'tok-phone',
      deviceId: 'phone',
      valid: true,
      registeredAt: 1,
    };
    const send = vi
      .fn()
      .mockImplementation((command: { constructor: { name: string } }) =>
        Promise.resolve(
          command.constructor.name === 'GetCommand'
            ? { Item: { pk: 'x', sk: 'METADATA', contactChannels: [phone], updatedAt: 3 } }
            : {},
        ),
      );
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization: (inner: unknown) => inner };
    });

    const { handler } = await import('./registerToken.js');
    await (handler as unknown as (e: GuardEvent, p: CedarPrincipalContext) => Promise<unknown>)(
      buildEvent('mbr-102', { platform: 'FCM', token: 'tok-tablet', deviceId: 'tablet' }),
      PRINCIPAL,
    );

    const transact = send.mock.calls[1]?.[0] as {
      input: {
        TransactItems: [
          { Update: { ExpressionAttributeValues: { ':cc': { deviceId?: string }[] } } },
          { Put: { Item: { payload: { contactChannels: unknown[] } } } },
        ];
      };
    };
    const devices = transact.input.TransactItems[0].Update.ExpressionAttributeValues[':cc'];
    expect(devices.map((entry) => entry.deviceId)).toEqual(['tablet', 'phone']);
    expect(transact.input.TransactItems[1].Put.Item.payload.contactChannels).toEqual(devices);
    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });

  it('M3: registering a phone takes it off the member who signed out of it without signal', async () => {
    const phone = { channel: 'PUSH', platform: 'FCM', token: 'tok-station', deviceId: 'station' };
    const members: Record<string, Record<string, unknown>> = {
      'mbr-102': { memberId: 'mbr-102', contactChannels: [], updatedAt: 1 },
      'mbr-101': { memberId: 'mbr-101', contactChannels: [phone], updatedAt: 1 },
    };
    const writes: { pk: string; cc: unknown[]; memberId: unknown }[] = [];
    const send = vi.fn().mockImplementation((command: SentCommand) => {
      const name = command.constructor.name;
      if (name === 'GetCommand') {
        const id = String(command.input.Key!.pk).split('#').at(-1)!;
        return Promise.resolve({
          Item: { pk: command.input.Key!.pk, sk: 'METADATA', ...members[id] },
        });
      }
      if (name === 'QueryCommand') return Promise.resolve({ Items: Object.values(members) });
      const [update, put] = command.input.TransactItems!;
      writes.push({
        pk: update.Update.Key.pk,
        cc: update.Update.ExpressionAttributeValues[':cc'],
        memberId: put.Put.Item.payload.memberId,
      });
      return Promise.resolve({});
    });
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization: (inner: unknown) => inner };
    });

    const { handler } = await import('./registerToken.js');
    const result = await (
      handler as unknown as (
        e: GuardEvent,
        p: CedarPrincipalContext,
      ) => Promise<{ statusCode: number }>
    )(
      buildEvent('mbr-102', { platform: 'FCM', token: 'tok-station', deviceId: 'station' }),
      PRINCIPAL,
    );

    expect(result.statusCode).toBe(200);
    expect(writes.map((w) => w.pk)).toEqual([
      'DEPT#NICHOLS#MEMBER#mbr-102',
      'DEPT#NICHOLS#MEMBER#mbr-101',
    ]);
    expect(writes[1]).toMatchObject({ cc: [], memberId: 'mbr-101' });
    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });

  it('M3: a failure releasing the installation elsewhere is logged, and the member stays registered', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: { pk: 'x', sk: 'METADATA', updatedAt: 1 } });
      }
      if (command.constructor.name === 'QueryCommand') {
        return Promise.reject(new Error('AccessDeniedException'));
      }
      return Promise.resolve({});
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization: (inner: unknown) => inner };
    });

    const { handler } = await import('./registerToken.js');
    const result = await (
      handler as unknown as (
        e: GuardEvent,
        p: CedarPrincipalContext,
      ) => Promise<{ statusCode: number }>
    )(buildEvent('mbr-102', { platform: 'FCM', token: 'tok-1', deviceId: 'd-1' }), PRINCIPAL);

    expect(result.statusCode).toBe(200);
    expect(error.mock.calls.map((c) => String(c[0])).join()).toContain(
      'personnel.pushToken.release.failed',
    );
    error.mockRestore();
    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });
});
