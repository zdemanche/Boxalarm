import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

describe('livenessHandler', () => {
  it('returns 200 with no dependency check', async () => {
    const { livenessHandler } = await import('./health.js');
    const result = await livenessHandler();
    expect(result).toMatchObject({ statusCode: 200 });
  });
});

describe('readinessHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 200 when the DynamoDB sentinel Query succeeds (readiness success)', async () => {
    const client = {
      send: vi.fn((command: unknown) => {
        if (command instanceof QueryCommand) {
          return Promise.resolve({ Items: [] });
        }
        throw new Error('unexpected command');
      }),
    } as unknown as DynamoDBDocumentClient;
    const { getDocumentClient } = await import('./dynamoClient.js');
    getDocumentClient(client);

    const { readinessHandler } = await import('./health.js');
    const result = await readinessHandler();

    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('returns 503 and logs the original error when DynamoDB is unavailable (readiness failure)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = {
      send: vi.fn().mockRejectedValue(new Error('Dynamo unavailable')),
    } as unknown as DynamoDBDocumentClient;
    const { getDocumentClient } = await import('./dynamoClient.js');
    getDocumentClient(client);

    const { readinessHandler } = await import('./health.js');
    const result = await readinessHandler();

    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('inspections.readiness.failed'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Dynamo unavailable'));
    errorSpy.mockRestore();
  });
});
