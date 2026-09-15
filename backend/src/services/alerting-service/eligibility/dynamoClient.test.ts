import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createDdbClient, readAlertingDdbConfig } from './dynamoClient.js';

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ marker: 'raw-client' })),
}));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: vi.fn().mockImplementation((raw: unknown) => ({ raw })) },
}));
vi.mock('aws-xray-sdk-core', () => ({
  default: { captureAWSv3Client: vi.fn().mockImplementation((raw: unknown) => raw) },
}));

describe('createDdbClient (production default path, no override)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('constructs an X-Ray-instrumented DynamoDBDocumentClient', async () => {
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
    const { createDdbClient: freshCreateDdbClient } = await import('./dynamoClient.js');
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient: MockedDocClient } = await import('@aws-sdk/lib-dynamodb');
    const AWSXRay = (await import('aws-xray-sdk-core')).default;

    freshCreateDdbClient(process.env);

    expect(DynamoDBClient).toHaveBeenCalledTimes(1);
    expect(AWSXRay.captureAWSv3Client).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- `from` is a vi.fn() mock, not a real class method
    expect(MockedDocClient.from).toHaveBeenCalledTimes(1);
  });
});

describe('readAlertingDdbConfig', () => {
  it('throws when ALERTING_TABLE_NAME is not set (fail-closed config)', () => {
    expect(() => readAlertingDdbConfig({})).toThrow(
      'ALERTING_TABLE_NAME is required and was not set',
    );
  });

  it('returns the table name when set', () => {
    expect(readAlertingDdbConfig({ ALERTING_TABLE_NAME: 'alerting-table' })).toEqual({
      tableName: 'alerting-table',
    });
  });
});

describe('createDdbClient', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reuses the same client instance across calls (module-singleton)', () => {
    const fake = {} as DynamoDBDocumentClient;
    const first = createDdbClient(process.env, fake);
    const second = createDdbClient(process.env, {} as DynamoDBDocumentClient);
    expect(first).toBe(second);
  });
});
