import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'mbr-1',
  deptId: 'NICHOLS',
  'cognito:groups': 'member',
};

function buildEvent(body: unknown): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/alerting/devices/state',
    rawPath: '/api/v1/alerting/devices/state',
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    body: JSON.stringify(body),
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

const VALID_BODY = {
  notificationPermission: true,
  criticalAlertPermission: false,
  batteryOptimizationExempt: true,
  appVersion: '1.2.0',
  osVersion: 'iOS 18',
};

describe('devices reportStateHandler', () => {
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

  it('persists a valid device self-report and returns 204', async () => {
    mockVerifiedPermissions('ALLOW');
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: vi.fn(() => ({ send })),
      readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
    }));

    const { handler } = await import('./reportStateHandler.js');
    const result = await handler(buildEvent(VALID_BODY));

    expect(result).toMatchObject({ statusCode: 204 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns 400 with field errors when a required field is missing', async () => {
    mockVerifiedPermissions('ALLOW');
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: vi.fn(() => ({})),
      readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
    }));

    const { handler } = await import('./reportStateHandler.js');
    const result = await handler(buildEvent({ ...VALID_BODY, appVersion: undefined }));

    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as { errors: unknown[] };
    expect(body.errors).toEqual([
      { field: 'appVersion', detail: expect.stringContaining('appVersion') as string },
    ]);
  });
});
