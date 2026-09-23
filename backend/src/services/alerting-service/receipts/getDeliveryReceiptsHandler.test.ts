import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';
import { deriveReceiptStatus } from './getDeliveryReceiptsHandler.js';

const OFFICER: CedarPrincipalContext = {
  sub: 'officer-1',
  deptId: 'NICHOLS',
  'cognito:groups': 'officer',
};

function buildEvent(
  principal: CedarPrincipalContext | undefined,
  headers: Record<string, string> | undefined = { authorization: 'Bearer token' },
  pathParameters?: Record<string, string>,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/alerting/dispatches/{dispatchId}/receipts',
    rawPath: '/api/v1/alerting/dispatches/NICHOLS-4471-1798000000/receipts',
    rawQueryString: '',
    headers,
    pathParameters,
    requestContext: { authorizer: { lambda: principal } },
  } as unknown as GuardEvent;
}

function mockVerifiedPermissions(sendImpl: () => Promise<{ decision: string }>): void {
  vi.doMock('@aws-sdk/client-verifiedpermissions', () => ({
    VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({ send: vi.fn(sendImpl) })),
    IsAuthorizedWithTokenCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
    BatchIsAuthorizedWithTokenCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
    Decision: { ALLOW: 'ALLOW', DENY: 'DENY' },
  }));
}

function mockDynamoClient(): void {
  vi.doMock('../eligibility/dynamoClient.js', () => ({
    createDynamoClient: vi.fn(() => ({})),
    readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
  }));
}

describe('deriveReceiptStatus (AC4)', () => {
  it('returns SENT when a channel just sent, well within the confirmation window', () => {
    expect(deriveReceiptStatus({ sentAt: 1000 }, 1010)).toBe('SENT');
  });

  it('returns SENT_UNCONFIRMED once past the provider window with no delivery/open/failure — distinguishable from delivered', () => {
    expect(deriveReceiptStatus({ sentAt: 1000 }, 1000 + 301)).toBe('SENT_UNCONFIRMED');
  });

  it('returns DELIVERED when deliveredAt is set', () => {
    expect(deriveReceiptStatus({ sentAt: 1000, deliveredAt: 1005 }, 5000)).toBe('DELIVERED');
  });

  it('returns OPENED over DELIVERED when both are set', () => {
    expect(deriveReceiptStatus({ sentAt: 1000, deliveredAt: 1005, openedAt: 1009 }, 5000)).toBe(
      'OPENED',
    );
  });

  it('returns FAILED when there is no positive delivery evidence', () => {
    expect(deriveReceiptStatus({ sentAt: 1000, failureReason: 'APNS_TIMEOUT' }, 5000)).toBe(
      'FAILED',
    );
  });

  it('returns DELIVERED (never FAILED) when a late/out-of-order failure callback lands on an already-delivered receipt', () => {
    expect(
      deriveReceiptStatus(
        { sentAt: 1000, deliveredAt: 1005, failureReason: 'LATE_CARRIER_FAIL' },
        5000,
      ),
    ).toBe('DELIVERED');
  });

  it('returns OPENED (never FAILED) when a late failure callback lands on an already-opened receipt', () => {
    expect(
      deriveReceiptStatus(
        { sentAt: 1000, deliveredAt: 1005, openedAt: 1009, failureReason: 'LATE_CARRIER_FAIL' },
        5000,
      ),
    ).toBe('OPENED');
  });
});

describe('getDeliveryReceiptsHandler', () => {
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
    vi.doUnmock('./deliveryReceiptRepository.js');
    vi.doUnmock('./logger.js');
  });

  it('returns 401 (fail-closed) on a missing/malformed bearer token (fail-secure)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const { handler } = await import('./getDeliveryReceiptsHandler.js');
    const result = await handler(
      buildEvent(OFFICER, {}, { dispatchId: 'NICHOLS-4471-1798000000' }),
    );
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 503 when Verified Permissions is unavailable (fail-secure, never a defaulted allow)', async () => {
    mockVerifiedPermissions(() => Promise.reject(new Error('VP outage')));
    const { handler } = await import('./getDeliveryReceiptsHandler.js');
    const result = await handler(
      buildEvent(OFFICER, undefined, { dispatchId: 'NICHOLS-4471-1798000000' }),
    );
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 400 for an empty dispatchId path parameter', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const { handler } = await import('./getDeliveryReceiptsHandler.js');
    const result = await handler(buildEvent(OFFICER, undefined, { dispatchId: '' }));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 200 with an empty array for a dispatch with no receipts (empty roster)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    mockDynamoClient();
    vi.doMock('./deliveryReceiptRepository.js', () => ({
      queryReceiptsForDispatch: vi.fn().mockResolvedValue([]),
    }));
    const { handler } = await import('./getDeliveryReceiptsHandler.js');
    const result = (await handler(
      buildEvent(OFFICER, undefined, { dispatchId: 'NICHOLS-4471-1798000000' }),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ receipts: [] });
  });

  it('returns per-member per-channel receipts with derived status (AC2, entrypoint test)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    mockDynamoClient();
    vi.doMock('./deliveryReceiptRepository.js', () => ({
      queryReceiptsForDispatch: vi.fn().mockResolvedValue([
        {
          memberId: 'MBR-0012',
          channel: 'PUSH',
          toneSequence: 1,
          sentAt: 1798000003,
          deliveredAt: 1798000004,
        },
      ]),
    }));
    const { handler } = await import('./getDeliveryReceiptsHandler.js');
    const result = (await handler(
      buildEvent(OFFICER, undefined, { dispatchId: 'NICHOLS-4471-1798000000' }),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    const parsed = JSON.parse(result.body) as { receipts: unknown[] };
    expect(parsed.receipts).toEqual([
      {
        memberId: 'MBR-0012',
        channel: 'PUSH',
        toneSequence: 1,
        status: 'DELIVERED',
        sentAt: 1798000003,
        deliveredAt: 1798000004,
        openedAt: null,
        failureReason: null,
      },
    ]);
  });

  it('maps a repository failure to 503 rather than an unhandled throw', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    mockDynamoClient();
    vi.doMock('./deliveryReceiptRepository.js', () => ({
      queryReceiptsForDispatch: vi.fn().mockRejectedValue(new Error('table not reachable')),
    }));
    const logError = vi.fn();
    vi.doMock('./logger.js', () => ({ logError, logInfo: vi.fn() }));
    const { handler } = await import('./getDeliveryReceiptsHandler.js');
    const result = await handler(
      buildEvent(OFFICER, undefined, { dispatchId: 'NICHOLS-4471-1798000000' }),
    );
    expect(result).toMatchObject({ statusCode: 503 });
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'table not reachable',
        dispatchId: 'NICHOLS-4471-1798000000',
      }),
    );
  });
});
