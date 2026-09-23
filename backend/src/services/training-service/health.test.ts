import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv, TRAINING_DYNAMO_TABLE_NAME: 'platform-service' };
});

describe('livenessHandler', () => {
  it('returns 200 unconditionally, unauthenticated', async () => {
    const { livenessHandler } = await import('./health.js');

    const result = await livenessHandler();

    expect(result).toMatchObject({ statusCode: 200 });
  });
});

describe('readinessHandler', () => {
  it('returns 200 when the DynamoDB table is reachable', async () => {
    const { createDynamoClient } = await import('./dynamoClient.js');
    const send = vi.fn().mockResolvedValue({ Table: { TableStatus: 'ACTIVE' } });
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const { readinessHandler } = await import('./health.js');

    const result = await readinessHandler();

    expect(result).toMatchObject({ statusCode: 200 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DescribeTableCommand);
  });

  it('returns 503 and logs the original error when DynamoDB is unreachable', async () => {
    const { createDynamoClient } = await import('./dynamoClient.js');
    const failure = new Error('DynamoDB unavailable');
    const send = vi.fn().mockRejectedValue(failure);
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { readinessHandler } = await import('./health.js');

    const result = await readinessHandler();

    expect(result).toMatchObject({ statusCode: 503 });
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.event).toBe('training.readiness.failed');
    errorSpy.mockRestore();
  });

  it('returns 503 when TRAINING_DYNAMO_TABLE_NAME is not configured', async () => {
    delete process.env.TRAINING_DYNAMO_TABLE_NAME;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { readinessHandler } = await import('./health.js');

    const result = await readinessHandler();

    expect(result).toMatchObject({ statusCode: 503 });
    errorSpy.mockRestore();
  });
});
