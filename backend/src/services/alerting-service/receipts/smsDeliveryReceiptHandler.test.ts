import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

function buildEvent(
  headers: Record<string, string> | undefined,
  body: unknown,
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/alerting/receipts/sms',
    rawPath: '/api/v1/alerting/receipts/sms',
    rawQueryString: '',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    requestContext: {},
  } as unknown as APIGatewayProxyEventV2;
}

const VALID_BODY = {
  deptId: 'NICHOLS',
  dispatchId: 'NICHOLS-4471-1798000000',
  memberId: 'MBR-0012',
  toneSequence: 1,
  status: 'delivered',
  providerTimestamp: 1798000004,
};

async function mockRepository(overrides: Record<string, unknown>): Promise<void> {
  const actual = await vi.importActual<typeof import('./deliveryReceiptRepository.js')>(
    './deliveryReceiptRepository.js',
  );
  vi.doMock('./deliveryReceiptRepository.js', () => ({ ...actual, ...overrides }));
}

describe('smsDeliveryReceiptHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.SMS_PROVIDER_WEBHOOK_SECRET = 'shared-secret';
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('../eligibility/dynamoClient.js');
    vi.doUnmock('./deliveryReceiptRepository.js');
    vi.doUnmock('./logger.js');
  });

  it('returns 401 on a missing/invalid vendor secret (AC3)', async () => {
    const { handler } = await import('./smsDeliveryReceiptHandler.js');
    const missing = (await handler(buildEvent(undefined, VALID_BODY))) as { statusCode: number };
    const invalid = (await handler(
      buildEvent({ 'x-sms-provider-secret': 'wrong' }, VALID_BODY),
    )) as { statusCode: number };
    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(401);
  });

  it('logs a structured rejection (no secret value) on a 401', async () => {
    const logInfo = vi.fn();
    vi.doMock('./logger.js', () => ({ logInfo, logError: vi.fn() }));
    const { handler } = await import('./smsDeliveryReceiptHandler.js');
    await handler(buildEvent({ 'x-sms-provider-secret': 'wrong' }, VALID_BODY));
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'alerting.receipts.sms.unauthorized' }),
    );
  });

  it('returns 400 for an empty body', async () => {
    const { handler } = await import('./smsDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent({ 'x-sms-provider-secret': 'shared-secret' }, ''),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 (never 503) when dispatchId contains the pk delimiter, and makes no DynamoDB call', async () => {
    const send = vi.fn();
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./smsDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent(
        { 'x-sms-provider-secret': 'shared-secret' },
        { ...VALID_BODY, dispatchId: 'A#ELIGIBILITY' },
      ),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 404 when no matching DELIVERY_RECEIPT item exists', async () => {
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({}),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    await mockRepository({
      updateDeliveryReceipt: vi.fn().mockResolvedValue({ outcome: 'not_found' }),
    });
    const { handler } = await import('./smsDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent({ 'x-sms-provider-secret': 'shared-secret' }, VALID_BODY),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(404);
  });

  it('returns 503 when DynamoDB is unavailable, and logs the original error', async () => {
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({}),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    await mockRepository({
      updateDeliveryReceipt: vi.fn().mockRejectedValue(new Error('table not reachable')),
    });
    const logError = vi.fn();
    vi.doMock('./logger.js', () => ({ logError, logInfo: vi.fn() }));
    const { handler } = await import('./smsDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent({ 'x-sms-provider-secret': 'shared-secret' }, VALID_BODY),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(503);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'table not reachable' }),
    );
  });

  it('returns 200 and updates the matching SMS receipt on a valid delivered callback (AC1, entrypoint test)', async () => {
    const updateDeliveryReceipt = vi.fn().mockResolvedValue({ outcome: 'updated' });
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({}),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    await mockRepository({ updateDeliveryReceipt });

    const { handler } = await import('./smsDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent({ 'x-sms-provider-secret': 'shared-secret' }, VALID_BODY),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      dispatchId: 'NICHOLS-4471-1798000000',
      memberId: 'MBR-0012',
      channel: 'sms',
      status: 'delivered',
    });
    expect(updateDeliveryReceipt).toHaveBeenCalledWith(
      {},
      'alerting-table',
      expect.objectContaining({ channel: 'sms', deliveredAt: 1798000004, deptId: 'NICHOLS' }),
    );
  });

  it('sets failureReason (never deliveredAt) on a failed status', async () => {
    const updateDeliveryReceipt = vi.fn().mockResolvedValue({ outcome: 'updated' });
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({}),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    await mockRepository({ updateDeliveryReceipt });

    const { handler } = await import('./smsDeliveryReceiptHandler.js');
    await handler(
      buildEvent(
        { 'x-sms-provider-secret': 'shared-secret' },
        { ...VALID_BODY, status: 'failed', failureReason: 'CARRIER_REJECTED' },
      ),
    );

    const call = updateDeliveryReceipt.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(call.failureReason).toBe('CARRIER_REJECTED');
    expect(call.deliveredAt).toBeUndefined();
  });

  it('rejects a deptId that is not a genuine prefix of dispatchId, and makes no DynamoDB call (P1, cross-tenant)', async () => {
    const send = vi.fn();
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./smsDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent(
        { 'x-sms-provider-secret': 'shared-secret' },
        { ...VALID_BODY, deptId: 'ATTACKER-DEPT' },
      ),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});
