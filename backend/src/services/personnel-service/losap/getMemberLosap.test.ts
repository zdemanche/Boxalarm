import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { GuardEvent } from '@boxalarm/authz';

const PRINCIPAL = { sub: 'mbr-102', deptId: 'NICHOLS', 'cognito:groups': 'member' };

function buildEvent(memberId: string | undefined): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/personnel/members/{memberId}/losap',
    rawPath: `/api/v1/personnel/members/${memberId ?? ''}/losap`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: memberId ? { memberId } : undefined,
    requestContext: { authorizer: { lambda: PRINCIPAL } },
  } as unknown as GuardEvent;
}

function mockAuthzAllow(): void {
  vi.doMock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
    return {
      ...actual,
      VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({
        send: vi.fn().mockResolvedValue({ decision: actual.Decision.ALLOW }),
      })),
    };
  });
}

function mockDynamo(send: ReturnType<typeof vi.fn>): void {
  vi.doMock('../dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../dynamoClient.js')>();
    return { ...actual, createDynamoClient: () => ({ send }) };
  });
}

describe('getMemberLosap handler', () => {
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

  it('returns the current-year running total summed from LOSAP_POINT_ENTRY items (AC3)', async () => {
    mockAuthzAllow();
    mockDynamo(vi.fn().mockResolvedValue({ Items: [{ points: 2 }, { points: 1 }] }));
    const { handler } = await import('./getMemberLosap.js');

    const result = (await handler(buildEvent('mbr-102'))) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body ?? '{}') as { memberId: string; totalPoints: number };
    expect(body.memberId).toBe('mbr-102');
    expect(body.totalPoints).toBe(3);
  });

  it('returns 400 when memberId path parameter is missing', async () => {
    mockAuthzAllow();
    mockDynamo(vi.fn());
    const { handler } = await import('./getMemberLosap.js');

    const result = await handler(buildEvent(undefined));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 503 when the ledger query fails', async () => {
    mockAuthzAllow();
    mockDynamo(vi.fn().mockRejectedValue(new Error('DynamoDB unavailable')));
    const { handler } = await import('./getMemberLosap.js');

    const result = await handler(buildEvent('mbr-102'));

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('denies a non-admin caller requesting another member LOSAP total even when Cedar allows (P4 defense-in-depth)', async () => {
    mockAuthzAllow();
    const dynamoSend = vi.fn();
    mockDynamo(dynamoSend);
    const { handler } = await import('./getMemberLosap.js');

    const result = await handler(buildEvent('mbr-999'));

    expect(result).toMatchObject({ statusCode: 403 });
    expect(dynamoSend).not.toHaveBeenCalled();
  });

  it('scopes the ledger query to the caller own department, not a cross-department GSI1 key (P4)', async () => {
    mockAuthzAllow();
    const dynamoSend = vi.fn().mockResolvedValue({ Items: [] });
    mockDynamo(dynamoSend);
    const { handler } = await import('./getMemberLosap.js');

    await handler(buildEvent('mbr-102'));

    const call = dynamoSend.mock.calls[0]?.[0] as {
      input: { IndexName?: string; ExpressionAttributeValues: Record<string, string> };
    };
    expect(call.input.IndexName).toBeUndefined();
    expect(call.input.ExpressionAttributeValues[':pk']).toBe('DEPT#NICHOLS#MEMBER#mbr-102');
  });
});
