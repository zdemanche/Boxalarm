import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'mbr-1',
  deptId: 'NICHOLS',
  'cognito:groups': 'member',
};

function buildEvent(dispatchId: string): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/alerting/diagnostics/{dispatchId}/me',
    rawPath: `/api/v1/alerting/diagnostics/${dispatchId}/me`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: { dispatchId },
    requestContext: { authorizer: { lambda: PRINCIPAL } },
  } as unknown as GuardEvent;
}

function mockVerifiedPermissions(decision: 'ALLOW' | 'DENY'): void {
  vi.doMock('@aws-sdk/client-verifiedpermissions', () => ({
    VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({ decision }),
    })),
    IsAuthorizedWithTokenCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
    BatchIsAuthorizedWithTokenCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
    Decision: { ALLOW: 'ALLOW', DENY: 'DENY' },
  }));
}

describe('diagnostics selfHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('@aws-sdk/client-verifiedpermissions');
    vi.doUnmock('../eligibility/dynamoClient.js');
  });

  it('a member can view their own delivery timeline without admin access (AC4)', async () => {
    mockVerifiedPermissions('ALLOW');
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: vi.fn(() => ({ send: vi.fn().mockResolvedValue({}) })),
      readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
    }));

    const { handler } = await import('./selfHandler.js');
    const result = await handler(buildEvent('dispatch-1'));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).toMatchObject({ dispatchId: 'dispatch-1', diagnosis: 'NOT_ON_ELIGIBLE_ROSTER' });
  });

  it('returns 503 when the diagnostics query fails', async () => {
    mockVerifiedPermissions('ALLOW');
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: vi.fn(() => ({
        send: vi.fn().mockRejectedValue(new Error('dynamo unavailable')),
      })),
      readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
    }));

    const { handler } = await import('./selfHandler.js');
    const result = await handler(buildEvent('dispatch-1'));

    expect(result).toMatchObject({ statusCode: 503 });
  });
});
