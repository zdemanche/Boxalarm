import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'chief-1',
  deptId: 'NICHOLS',
  'cognito:groups': 'chief',
};

function buildEvent(memberId: string, body: unknown): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/personnel/members/{memberId}/status',
    rawPath: `/api/v1/personnel/members/${memberId}/status`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: { memberId },
    body: JSON.stringify(body),
    requestContext: { authorizer: { lambda: PRINCIPAL } },
  } as unknown as GuardEvent;
}

function mockAuthzPassthrough(): void {
  vi.doMock('@boxalarm/authz', async () => {
    const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
    return { ...actual, withAuthorization: (inner: unknown) => inner };
  });
}

describe('parseStatusBody', () => {
  it('throws when status is absent', async () => {
    const { parseStatusBody } = await import('./statusChange.js');
    expect(() => parseStatusBody(JSON.stringify({}))).toThrow('status is required');
  });

  it('throws when status is not in the enum', async () => {
    const { parseStatusBody } = await import('./statusChange.js');
    expect(() => parseStatusBody(JSON.stringify({ status: 'ON_VACATION' }))).toThrow(
      'status is required',
    );
  });

  it('parses a valid status', async () => {
    const { parseStatusBody } = await import('./statusChange.js');
    expect(parseStatusBody(JSON.stringify({ status: 'RETIRED' }))).toEqual({ status: 'RETIRED' });
  });
});

describe('statusChange handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PERSONNEL_TABLE_NAME = 'personnel-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });

  it('returns 400 problem+json when body.status is not in the enum (AC-matrix)', async () => {
    mockAuthzPassthrough();
    const { handler } = await import('./statusChange.js');
    const event = buildEvent('mbr-1', { status: 'ON_VACATION' });
    const result = await (
      handler as unknown as (
        e: GuardEvent,
        p: CedarPrincipalContext,
      ) => Promise<{
        statusCode: number;
      }>
    )(event, PRINCIPAL);
    expect(result.statusCode).toBe(400);
  });

  it('clears contactChannels to [] and returns 200 on a transition to a non-ACTIVE status (AC5)', async () => {
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    mockAuthzPassthrough();

    const { handler } = await import('./statusChange.js');
    const event = buildEvent('mbr-1', { status: 'RETIRED' });
    const result = await (
      handler as unknown as (
        e: GuardEvent,
        p: CedarPrincipalContext,
      ) => Promise<{
        statusCode: number;
        body: string;
      }>
    )(event, PRINCIPAL);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ status: 'RETIRED', contactChannels: [] });

    const transactCall = send.mock.calls[0]?.[0] as {
      input: {
        TransactItems: [
          {
            Update: {
              UpdateExpression: string;
              ExpressionAttributeValues: Record<string, unknown>;
            };
          },
          { Put: { Item: Record<string, unknown> } },
        ];
      };
    };
    expect(transactCall.input.TransactItems[0].Update.UpdateExpression).toContain(
      'contactChannels',
    );
    expect(transactCall.input.TransactItems[1].Put.Item.eventType).toBe('personnel.member.updated');
  });

  it('does not clear contactChannels on a transition to ACTIVE', async () => {
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    mockAuthzPassthrough();

    const { handler } = await import('./statusChange.js');
    const event = buildEvent('mbr-1', { status: 'ACTIVE' });
    await (handler as unknown as (e: GuardEvent, p: CedarPrincipalContext) => Promise<unknown>)(
      event,
      PRINCIPAL,
    );

    const transactCall = send.mock.calls[0]?.[0] as {
      input: { TransactItems: [{ Update: { UpdateExpression: string } }] };
    };
    expect(transactCall.input.TransactItems[0].Update.UpdateExpression).not.toContain(
      'contactChannels',
    );
  });

  it('returns 404 problem+json when the member does not exist', async () => {
    const { TransactionCanceledException } = await import('@aws-sdk/client-dynamodb');
    const send = vi.fn().mockRejectedValue(
      new TransactionCanceledException({
        message: 'cancelled',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        $metadata: {},
      }),
    );
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    mockAuthzPassthrough();

    const { handler } = await import('./statusChange.js');
    const event = buildEvent('mbr-missing', { status: 'RETIRED' });
    const result = await (
      handler as unknown as (
        e: GuardEvent,
        p: CedarPrincipalContext,
      ) => Promise<{
        statusCode: number;
      }>
    )(event, PRINCIPAL);

    expect(result.statusCode).toBe(404);
  });

  it('rethrows (does not map to 404) a TransactionCanceledException whose cancellation reason is not ConditionalCheckFailed (P12 regression)', async () => {
    const { TransactionCanceledException } = await import('@aws-sdk/client-dynamodb');
    const send = vi.fn().mockRejectedValue(
      new TransactionCanceledException({
        message: 'cancelled',
        CancellationReasons: [{ Code: 'TransactionConflict' }],
        $metadata: {},
      }),
    );
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    mockAuthzPassthrough();

    const { handler } = await import('./statusChange.js');
    const event = buildEvent('mbr-1', { status: 'RETIRED' });
    await expect(
      (handler as unknown as (e: GuardEvent, p: CedarPrincipalContext) => Promise<unknown>)(
        event,
        PRINCIPAL,
      ),
    ).rejects.toThrow('cancelled');
  });
});
