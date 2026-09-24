import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'officer-1',
  deptId: 'NICHOLS',
  'cognito:groups': 'officer',
};

function buildEvent(dispatchId: string, memberId: string): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/alerting/diagnostics/{dispatchId}/{memberId}',
    rawPath: `/api/v1/alerting/diagnostics/${dispatchId}/${memberId}`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: { dispatchId, memberId },
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

describe('diagnostics handler (admin)', () => {
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

  it('returns 200 with a NOT_ON_ELIGIBLE_ROSTER diagnosis when no roster entry exists (AC5)', async () => {
    mockVerifiedPermissions('ALLOW');
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: vi.fn(() => ({ send: vi.fn().mockResolvedValue({}) })),
      readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
    }));

    const { handler } = await import('./handler.js');
    const result = await handler(buildEvent('dispatch-1', 'mbr-1'));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).toMatchObject({ diagnosis: 'NOT_ON_ELIGIBLE_ROSTER' });
  });

  it('returns 403 on Cedar deny — an admin/officer action, not open to any member', async () => {
    mockVerifiedPermissions('DENY');
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: vi.fn(() => ({})),
      readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
    }));

    const { handler } = await import('./handler.js');
    const result = await handler(buildEvent('dispatch-1', 'mbr-1'));

    expect(result).toMatchObject({ statusCode: 403 });
  });
});
