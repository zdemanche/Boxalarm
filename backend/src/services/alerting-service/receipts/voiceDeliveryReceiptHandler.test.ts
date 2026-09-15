import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

function buildEvent(
  headers: Record<string, string> | undefined,
  body: unknown,
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/alerting/receipts/voice',
    rawPath: '/api/v1/alerting/receipts/voice',
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
  providerTimestamp: 1798000100,
};

describe('voiceDeliveryReceiptHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VOICE_PROVIDER_WEBHOOK_SECRET = 'shared-secret';
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('../eligibility/dynamoClient.js');
    vi.doUnmock('./deliveryReceiptRepository.js');
  });

  it('returns 401 on a missing/invalid vendor secret (AC3)', async () => {
    const { handler } = await import('./voiceDeliveryReceiptHandler.js');
    const missing = (await handler(buildEvent(undefined, VALID_BODY))) as { statusCode: number };
    const invalid = (await handler(
      buildEvent({ 'x-voice-provider-secret': 'wrong' }, VALID_BODY),
    )) as { statusCode: number };
    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(401);
  });

  it('returns 400 when a required field is missing', async () => {
    const { handler } = await import('./voiceDeliveryReceiptHandler.js');
    const withoutDispatchId: Record<string, unknown> = { ...VALID_BODY };
    delete withoutDispatchId.dispatchId;
    const result = (await handler(
      buildEvent({ 'x-voice-provider-secret': 'shared-secret' }, withoutDispatchId),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('returns 404 when no matching DELIVERY_RECEIPT item exists', async () => {
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({}),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    vi.doMock('./deliveryReceiptRepository.js', () => ({
      updateDeliveryReceipt: vi.fn().mockResolvedValue({ outcome: 'not_found' }),
    }));
    const { handler } = await import('./voiceDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent({ 'x-voice-provider-secret': 'shared-secret' }, VALID_BODY),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(404);
  });

  it('returns 503 when DynamoDB is unavailable', async () => {
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({}),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    vi.doMock('./deliveryReceiptRepository.js', () => ({
      updateDeliveryReceipt: vi.fn().mockRejectedValue(new Error('table not reachable')),
    }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./voiceDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent({ 'x-voice-provider-secret': 'shared-secret' }, VALID_BODY),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(503);
  });

  it('returns 200 and updates the matching VOICE receipt at the escalation tone (AC1, entrypoint test)', async () => {
    const updateDeliveryReceipt = vi.fn().mockResolvedValue({ outcome: 'updated' });
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({}),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    vi.doMock('./deliveryReceiptRepository.js', () => ({ updateDeliveryReceipt }));

    const { handler } = await import('./voiceDeliveryReceiptHandler.js');
    const result = (await handler(
      buildEvent({ 'x-voice-provider-secret': 'shared-secret' }, VALID_BODY),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      dispatchId: 'NICHOLS-4471-1798000000',
      memberId: 'MBR-0012',
      channel: 'VOICE',
      status: 'delivered',
    });
    expect(updateDeliveryReceipt).toHaveBeenCalledWith(
      {},
      'alerting-table',
      expect.objectContaining({ channel: 'VOICE', deliveredAt: 1798000100 }),
    );
  });
});
