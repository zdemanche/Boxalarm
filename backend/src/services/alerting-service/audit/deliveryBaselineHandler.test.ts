import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'admin-1',
  deptId: 'NICHOLS',
  'cognito:groups': 'admin',
};

function buildEvent(queryStringParameters: Record<string, string> | undefined): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/alerting/audit/delivery-baseline',
    rawPath: '/api/v1/alerting/audit/delivery-baseline',
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    queryStringParameters,
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

describe('deliveryBaselineHandler', () => {
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

  it('rejects a from/to range wider than 90 days with an RFC7807 field error (MINOR #7)', async () => {
    mockVerifiedPermissions('ALLOW');
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: vi.fn(() => ({ send: vi.fn() })),
      readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
    }));

    const { handler } = await import('./deliveryBaselineHandler.js');
    const from = 0;
    const to = 91 * 24 * 60 * 60; // 91 days — over the cap
    const result = await handler(buildEvent({ from: String(from), to: String(to) }));

    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as { errors?: unknown[] };
    expect(body.errors).toEqual([
      { field: 'to', detail: expect.stringContaining('90 days') as string },
    ]);
  });

  it('serves the baseline for a range within the 90-day cap', async () => {
    mockVerifiedPermissions('ALLOW');
    const send = vi.fn().mockResolvedValue({ Items: [] });
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: vi.fn(() => ({ send })),
      readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
    }));

    const { handler } = await import('./deliveryBaselineHandler.js');
    const from = 0;
    const to = 89 * 24 * 60 * 60; // 89 days — within the cap
    const result = await handler(buildEvent({ from: String(from), to: String(to) }));

    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('returns 400 when from/to are missing', async () => {
    mockVerifiedPermissions('ALLOW');
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: vi.fn(() => ({ send: vi.fn() })),
      readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
    }));

    const { handler } = await import('./deliveryBaselineHandler.js');
    const result = await handler(buildEvent(undefined));

    expect(result).toMatchObject({ statusCode: 400 });
  });
});
