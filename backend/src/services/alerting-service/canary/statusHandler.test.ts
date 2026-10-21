import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'admin-1',
  deptId: 'NICHOLS',
  'cognito:groups': 'admin',
};

function buildEvent(): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/alerting/canary/status',
    rawPath: '/api/v1/alerting/canary/status',
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    requestContext: { authorizer: { lambda: PRINCIPAL } },
  } as unknown as GuardEvent;
}

function mockVerifiedPermissions(decision: 'ALLOW' | 'DENY'): void {
  vi.doMock('@aws-sdk/client-verifiedpermissions', () => ({
    VerifiedPermissionsClient: vi.fn().mockImplementation(function () {
      return {
        send: vi.fn().mockResolvedValue({ decision }),
      };
    }),
    IsAuthorizedWithTokenCommand: vi.fn().mockImplementation(function (input: unknown) {
      return { input };
    }),
    BatchIsAuthorizedWithTokenCommand: vi.fn().mockImplementation(function (input: unknown) {
      return { input };
    }),
    Decision: { ALLOW: 'ALLOW', DENY: 'DENY' },
  }));
}

describe('canary statusHandler', () => {
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

  it('reports unhealthy when the latest run failed (AC5, N8.3 self-diagnosis feed)', async () => {
    mockVerifiedPermissions('ALLOW');
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: vi.fn(() => ({
        send: vi.fn().mockResolvedValue({
          Items: [{ result: 'FAIL', latencyMs: 9000, ranAt: 100, testId: 'canary-1' }],
        }),
      })),
      readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
    }));

    const { handler } = await import('./statusHandler.js');
    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).toMatchObject({ healthy: false, latestResult: 'FAIL' });
  });

  it('falls back to the previous UTC day just after midnight, before the first tick of the new day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 27, 0, 0, 30));
    try {
      mockVerifiedPermissions('ALLOW');
      const send = vi
        .fn()
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({
          Items: [{ result: 'PASS', latencyMs: 800, ranAt: 1_790_380_770, testId: 'canary-1' }],
        });
      vi.doMock('../eligibility/dynamoClient.js', () => ({
        createDynamoClient: vi.fn(() => ({ send })),
        readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
      }));

      const { handler } = await import('./statusHandler.js');
      const result = await handler(buildEvent());

      const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
      expect(body).toMatchObject({ healthy: true, latestResult: 'PASS' });
      const secondQuery = send.mock.calls[1]?.[0] as {
        input: { ExpressionAttributeValues: Record<string, string> };
      };
      expect(JSON.stringify(secondQuery.input)).toContain('#CANARY#2026-09-26');
    } finally {
      vi.useRealTimers();
    }
  });
});
