import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuardEvent } from '@boxalarm/authz';

const PRINCIPAL = { sub: 'mbr-102', deptId: 'NICHOLS', 'cognito:groups': 'member' };

function buildEvent(memberId: string): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/personnel/members/{memberId}/losap',
    rawPath: `/api/v1/personnel/members/${memberId}/losap`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: { memberId },
    requestContext: { authorizer: { lambda: PRINCIPAL } },
  } as unknown as GuardEvent;
}

describe('getMemberLosap authz', () => {
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

  it('denies (fails closed) when Cedar denies viewing another member LOSAP total', async () => {
    vi.doMock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
      return {
        ...actual,
        VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({
          send: vi.fn().mockResolvedValue({ decision: actual.Decision.DENY }),
        })),
      };
    });
    const dynamoSend = vi.fn();
    vi.doMock('../dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ({ send: dynamoSend }) };
    });
    const { handler } = await import('./getMemberLosap.js');

    const result = await handler(buildEvent('mbr-999'));

    expect(result).toMatchObject({ statusCode: 403 });
    expect(dynamoSend).not.toHaveBeenCalled();
  });
});
