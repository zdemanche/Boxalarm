import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { GuardEvent } from '@boxalarm/authz';

const DEPT_ID = 'NICHOLS';
const MEMBER_ID = 'mbr-102';
const PRINCIPAL = { sub: MEMBER_ID, deptId: DEPT_ID, 'cognito:groups': 'member' };

function buildEvent(
  options: {
    readonly headers?: Record<string, string> | undefined;
    readonly principal?: Record<string, unknown> | null;
    readonly pathParameters?: Record<string, string>;
  } = {},
): GuardEvent {
  const principal = options.principal === null ? undefined : (options.principal ?? PRINCIPAL);
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/personnel/attendance',
    rawPath: '/api/v1/personnel/attendance',
    rawQueryString: '',
    headers: 'headers' in options ? options.headers : { authorization: 'Bearer token' },
    pathParameters: options.pathParameters,
    requestContext: { authorizer: { lambda: principal } },
  } as unknown as GuardEvent;
}

function mockAuthzDecision(decision: 'ALLOW' | 'DENY' | 'ERROR'): void {
  vi.doMock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
    return {
      ...actual,
      VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({
        send:
          decision === 'ERROR'
            ? vi.fn().mockRejectedValue(new Error('VP outage'))
            : vi.fn().mockResolvedValue({ decision: actual.Decision[decision] }),
      })),
    };
  });
}

function mockDynamo(
  behavior: 'OK' | 'ERROR' | 'MEMBER_NOT_FOUND',
  items: unknown[] = [],
): { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn((command: { constructor: { name: string } }) => {
    if (behavior === 'ERROR') {
      return Promise.reject(new Error('DynamoDB unavailable'));
    }
    if (command.constructor.name === 'GetCommand') {
      return Promise.resolve({
        Item: behavior === 'MEMBER_NOT_FOUND' ? undefined : { entityType: 'MEMBER' },
      });
    }
    return Promise.resolve({ Items: items });
  });
  const client = { send };
  vi.doMock('../dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../dynamoClient.js')>();
    return { ...actual, createDynamoClient: () => client };
  });
  return client;
}

describe('queryHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('@aws-sdk/client-verifiedpermissions');
    vi.doUnmock('../dynamoClient.js');
  });

  it('queries GSI1 for all activity types in one call, sorted by occurredAt (AC3)', async () => {
    mockAuthzDecision('ALLOW');
    const records = [
      { activityType: 'DRILL', occurredAt: 1 },
      { activityType: 'CALL', occurredAt: 2 },
    ];
    const client = mockDynamo('OK', records);
    const { handler } = await import('./queryHandler.js');

    const result = (await handler(buildEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    const queryCall = client.send.mock.calls[1]?.[0] as {
      input: {
        IndexName: string;
        KeyConditionExpression: string;
        ExpressionAttributeValues: Record<string, string>;
        ScanIndexForward: boolean;
      };
    };
    expect(queryCall.input.IndexName).toBe('GSI1');
    expect(queryCall.input.ExpressionAttributeValues[':gsi1pk']).toBe('MEMBER#mbr-102');
    expect(queryCall.input.ExpressionAttributeValues[':prefix']).toBe('ATTENDANCE_RECORD#');
    expect(queryCall.input.ScanIndexForward).toBe(true);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ records });
  });

  it('filters GSI1 results by the caller deptId, since gsi1pk carries no dept segment (MAJOR #4 regression)', async () => {
    mockAuthzDecision('ALLOW');
    const client = mockDynamo('OK', []);
    const { onBehalfHandler } = await import('./queryHandler.js');

    await onBehalfHandler(buildEvent({ pathParameters: { memberId: 'mbr-999' } }));

    const queryCall = client.send.mock.calls[1]?.[0] as {
      input: { FilterExpression: string; ExpressionAttributeValues: Record<string, string> };
    };
    expect(queryCall.input.FilterExpression).toBe('deptId = :deptId');
    expect(queryCall.input.ExpressionAttributeValues[':deptId']).toBe('NICHOLS');
  });

  it('denies (fails closed) when Cedar denies the action', async () => {
    mockAuthzDecision('DENY');
    const client = mockDynamo('OK');
    const { handler } = await import('./queryHandler.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 403 });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('denies (fails closed) with 503, never a defaulted allow, when Verified Permissions is unavailable (core-harm)', async () => {
    mockAuthzDecision('ERROR');
    const client = mockDynamo('OK');
    const { handler } = await import('./queryHandler.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 503 });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('returns 503 (fail-closed) when the DynamoDB query fails', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('ERROR');
    const { handler } = await import('./queryHandler.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('logs the original error before returning a problem response on a DynamoDB failure (error-path-logging)', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('ERROR');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./queryHandler.js');

    await handler(buildEvent());

    expect(errorSpy).toHaveBeenCalled();
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as {
      originalError?: string;
      reason?: string;
    };
    expect(logged.originalError).toBeTruthy();
    expect(logged.reason).toBeTruthy();
    errorSpy.mockRestore();
  });

  it('returns 404 and never queries GSI1 when the caller is not a known member of the department', async () => {
    mockAuthzDecision('ALLOW');
    const client = mockDynamo('MEMBER_NOT_FOUND');
    const { handler } = await import('./queryHandler.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 404 });
    expect(
      client.send.mock.calls.some(
        (call) =>
          (call[0] as { constructor: { name: string } }).constructor.name === 'QueryCommand',
      ),
    ).toBe(false);
  });
});

describe('onBehalfHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('@aws-sdk/client-verifiedpermissions');
    vi.doUnmock('../dynamoClient.js');
  });

  it('queries GSI1 for the target memberId, not the caller, when Cedar allows', async () => {
    mockAuthzDecision('ALLOW');
    const client = mockDynamo('OK', [{ activityType: 'DRILL', occurredAt: 1 }]);
    const { onBehalfHandler } = await import('./queryHandler.js');

    const result = (await onBehalfHandler(
      buildEvent({ pathParameters: { memberId: 'mbr-999' } }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    const queryCall = client.send.mock.calls[1]?.[0] as {
      input: { ExpressionAttributeValues: Record<string, string> };
    };
    expect(queryCall.input.ExpressionAttributeValues[':gsi1pk']).toBe('MEMBER#mbr-999');
  });

  it("rejects (fails closed) a cross-department read: 404, never a Query, when the target memberId is not a member of the caller's department (CRITICAL, PR #320 review)", async () => {
    mockAuthzDecision('ALLOW');
    const client = mockDynamo('MEMBER_NOT_FOUND');
    const { onBehalfHandler } = await import('./queryHandler.js');

    const result = await onBehalfHandler(
      buildEvent({ pathParameters: { memberId: 'mbr-other-dept' } }),
    );

    expect(result).toMatchObject({ statusCode: 404 });
    expect(
      client.send.mock.calls.some(
        (call) =>
          (call[0] as { constructor: { name: string } }).constructor.name === 'QueryCommand',
      ),
    ).toBe(false);
  });

  it("scopes the dept-membership check to the caller's own department (GetCommand keyed by pk, not a bare memberId)", async () => {
    mockAuthzDecision('ALLOW');
    const client = mockDynamo('OK', [{ activityType: 'DRILL', occurredAt: 1 }]);
    const { onBehalfHandler } = await import('./queryHandler.js');

    await onBehalfHandler(buildEvent({ pathParameters: { memberId: 'mbr-999' } }));

    const getCall = client.send.mock.calls[0]?.[0] as {
      input: { Key: { pk: string; sk: string } };
    };
    expect(getCall.input.Key).toEqual({ pk: 'DEPT#NICHOLS#MEMBER#mbr-999', sk: 'METADATA' });
  });

  it('denies (fails closed) when Cedar denies the on-behalf action', async () => {
    mockAuthzDecision('DENY');
    const client = mockDynamo('OK');
    const { onBehalfHandler } = await import('./queryHandler.js');

    const result = await onBehalfHandler(buildEvent({ pathParameters: { memberId: 'mbr-999' } }));

    expect(result).toMatchObject({ statusCode: 403 });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('returns 404 when the memberId path parameter is missing', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK');
    const { onBehalfHandler } = await import('./queryHandler.js');

    const result = await onBehalfHandler(buildEvent({ pathParameters: {} }));

    expect(result).toMatchObject({ statusCode: 404 });
  });
});
