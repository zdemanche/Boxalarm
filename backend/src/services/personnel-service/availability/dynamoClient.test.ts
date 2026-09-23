import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createDdbClient, parseMarkoffItem, readPersonnelDdbConfig } from './dynamoClient.js';

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
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
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

describe('readPersonnelDdbConfig', () => {
  it('throws when PLATFORM_TABLE_NAME is not set (fail-closed config)', () => {
    expect(() => readPersonnelDdbConfig({})).toThrow(
      'PLATFORM_TABLE_NAME is required and was not set',
    );
  });

  it('returns the table name when set', () => {
    expect(readPersonnelDdbConfig({ PLATFORM_TABLE_NAME: 'platform-table' })).toEqual({
      tableName: 'platform-table',
    });
  });
});

describe('createDdbClient', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
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

describe('parseMarkoffItem', () => {
  it('returns undefined for an absent item', () => {
    expect(parseMarkoffItem(undefined)).toBeUndefined();
  });

  it('parses a well-shaped item', () => {
    const item = {
      pk: 'DEPT#NICHOLS#MEMBER#MBR-1',
      sk: 'MARKOFF#100',
      entityType: 'AVAILABILITY_MARKOFF',
      memberId: 'MBR-1',
      deptId: 'NICHOLS',
      startAt: 100,
      endAt: 200,
      reason: 'Vacation',
      affectsAlerting: true,
    };
    expect(parseMarkoffItem(item)).toEqual(item);
  });

  it('throws on a malformed item (missing required field)', () => {
    expect(() =>
      parseMarkoffItem({ pk: 'x', sk: 'y', entityType: 'AVAILABILITY_MARKOFF' }),
    ).toThrow('AVAILABILITY_MARKOFF item failed shape validation');
  });
});
