import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

function buildEvent(
  headers: Record<string, string> | undefined,
  body: unknown,
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/alerting/receipts/push',
    rawPath: '/api/v1/alerting/receipts/push',
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

describe('pushDeliveryReceiptHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PUSH_PROVIDER_WEBHOOK_SECRET = 'shared-secret';
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('../eligibility/dynamoClient.js');
    vi.doUnmock('./deliveryReceiptRepository.js');
    vi.doUnmock('./logger.js');
  });

  it('returns 401 on a missing vendor secret (AC3)', async () => {
    const { handler } = await import('./pushDeliveryReceiptHandler.js');
    const result = (await handler(buildEvent(undefined, VALID_BODY))) as { statusCode: number };
    expect(result.statusCode).toBe(401);
  });

  it('returns 401 on a mismatched vendor secret (AC3)', async () => {
    const { handler } = await import('./pushDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent({ 'x-push-provider-secret': 'wrong' }, VALID_BODY),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(401);
  });

  it('returns 401 for a valid Cognito bearer token alone, with no vendor secret (AC3: never accepted as a Cognito call)', async () => {
    const { handler } = await import('./pushDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent({ authorization: 'Bearer valid-jwt' }, VALID_BODY),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(401);
  });

  it('logs a structured rejection (no secret value) on a 401, for rejected-webhook forensics', async () => {
    const logInfo = vi.fn();
    vi.doMock('./logger.js', () => ({ logInfo, logError: vi.fn() }));
    const { handler } = await import('./pushDeliveryReceiptHandler.js');
    await handler(buildEvent({ 'x-push-provider-secret': 'wrong' }, VALID_BODY));
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'alerting.receipts.push.unauthorized' }),
    );
    const fields = logInfo.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(fields)).not.toContain('wrong');
  });

  it('returns 400 for malformed JSON and makes no DynamoDB call', async () => {
    const send = vi.fn();
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./pushDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent({ 'x-push-provider-secret': 'shared-secret' }, '{not json'),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('logs a structured rejection on a 400 validation failure', async () => {
    const logInfo = vi.fn();
    vi.doMock('./logger.js', () => ({ logInfo, logError: vi.fn() }));
    const { handler } = await import('./pushDeliveryReceiptHandler.js');
    await handler(buildEvent({ 'x-push-provider-secret': 'shared-secret' }, '{not json'));
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'alerting.receipts.push.rejected' }),
    );
  });

  it('returns 400 when toneSequence is absent', async () => {
    const { handler } = await import('./pushDeliveryReceiptHandler.js');
    const withoutTone: Record<string, unknown> = { ...VALID_BODY };
    delete withoutTone.toneSequence;
    const result = (await handler(
      buildEvent({ 'x-push-provider-secret': 'shared-secret' }, withoutTone),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when toneSequence is a string instead of a number', async () => {
    const { handler } = await import('./pushDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent(
        { 'x-push-provider-secret': 'shared-secret' },
        { ...VALID_BODY, toneSequence: '1' },
      ),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when providerTimestamp is unparseable', async () => {
    const { handler } = await import('./pushDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent(
        { 'x-push-provider-secret': 'shared-secret' },
        { ...VALID_BODY, providerTimestamp: 'not-a-date' },
      ),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when memberId is an object instead of a scalar', async () => {
    const { handler } = await import('./pushDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent(
        { 'x-push-provider-secret': 'shared-secret' },
        { ...VALID_BODY, memberId: { id: 'MBR-0012' } },
      ),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 (never 503) when dispatchId contains the pk delimiter, and makes no DynamoDB call', async () => {
    const send = vi.fn();
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./pushDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent(
        { 'x-push-provider-secret': 'shared-secret' },
        { ...VALID_BODY, dispatchId: 'A#ELIGIBILITY' },
      ),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 404 when no matching DELIVERY_RECEIPT item exists for this channel attempt', async () => {
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({}),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    vi.doMock('./deliveryReceiptRepository.js', async () => {
      const actual = await vi.importActual<typeof import('./deliveryReceiptRepository.js')>(
        './deliveryReceiptRepository.js',
      );
      return {
        ...actual,
        updateDeliveryReceipt: vi.fn().mockResolvedValue({ outcome: 'not_found' }),
      };
    });
    const { handler } = await import('./pushDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent({ 'x-push-provider-secret': 'shared-secret' }, VALID_BODY),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(404);
  });

  it('returns 503 when DynamoDB is unavailable, and logs the original error (fail-closed, error-path-logging)', async () => {
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({}),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    vi.doMock('./deliveryReceiptRepository.js', async () => {
      const actual = await vi.importActual<typeof import('./deliveryReceiptRepository.js')>(
        './deliveryReceiptRepository.js',
      );
      return {
        ...actual,
        updateDeliveryReceipt: vi.fn().mockRejectedValue(new Error('table not reachable')),
      };
    });
    const logError = vi.fn();
    vi.doMock('./logger.js', () => ({ logError, logInfo: vi.fn() }));

    const { handler } = await import('./pushDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent({ 'x-push-provider-secret': 'shared-secret' }, VALID_BODY),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(503);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'table not reachable' }),
    );
  });

  it('returns 200 and updates the matching receipt on a valid delivered callback (AC1, entrypoint test)', async () => {
    const updateDeliveryReceipt = vi.fn().mockResolvedValue({ outcome: 'updated' });
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({}),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    vi.doMock('./deliveryReceiptRepository.js', async () => {
      const actual = await vi.importActual<typeof import('./deliveryReceiptRepository.js')>(
        './deliveryReceiptRepository.js',
      );
      return { ...actual, updateDeliveryReceipt };
    });

    const { handler } = await import('./pushDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent({ 'x-push-provider-secret': 'shared-secret' }, VALID_BODY),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      dispatchId: 'NICHOLS-4471-1798000000',
      memberId: 'MBR-0012',
      channel: 'push',
      status: 'delivered',
    });
    expect(updateDeliveryReceipt).toHaveBeenCalledWith(
      {},
      'alerting-table',
      expect.objectContaining({
        dispatchId: 'NICHOLS-4471-1798000000',
        memberId: 'MBR-0012',
        channel: 'push',
        toneSequence: 1,
        deliveredAt: 1798000004,
      }),
    );
  });

  it('rejects a deptId that is not a genuine prefix of dispatchId, and makes no DynamoDB call (P1, cross-tenant)', async () => {
    const send = vi.fn();
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./pushDeliveryReceiptHandler.js');
    // An attacker holding the single channel-wide secret cannot redirect the write to a
    // different department by supplying an unrelated deptId — dispatchId is minted as
    // `${deptId}-...`, so a deptId that isn't a prefix of this dispatchId is rejected.
    const result = (await handler(
      buildEvent(
        { 'x-push-provider-secret': 'shared-secret' },
        { ...VALID_BODY, deptId: 'ATTACKER-DEPT' },
      ),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('emits a PushReceiptUpdated business metric on success (business-metrics obligation)', async () => {
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({}),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    vi.doMock('./deliveryReceiptRepository.js', async () => {
      const actual = await vi.importActual<typeof import('./deliveryReceiptRepository.js')>(
        './deliveryReceiptRepository.js',
      );
      return {
        ...actual,
        updateDeliveryReceipt: vi.fn().mockResolvedValue({ outcome: 'updated' }),
      };
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { handler } = await import('./pushDeliveryReceiptHandler.js');
    await handler(buildEvent({ 'x-push-provider-secret': 'shared-secret' }, VALID_BODY));

    const metricLine = logSpy.mock.calls
      .map((call) => call[0] as string)
      .find((line) => line.includes('PushReceiptUpdated'));
    expect(metricLine).toBeDefined();
  });
});
