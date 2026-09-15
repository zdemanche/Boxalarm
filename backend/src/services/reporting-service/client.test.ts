import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

describe('readGrantsReportConfig', () => {
  it('reads all three table names', async () => {
    const { readGrantsReportConfig } = await import('./client.js');
    expect(
      readGrantsReportConfig({
        PERSONNEL_TABLE_NAME: 'personnel-table',
        TRAINING_DYNAMO_TABLE_NAME: 'training-table',
        PLATFORM_TABLE_NAME: 'platform-table',
      }),
    ).toEqual({
      personnelTableName: 'personnel-table',
      trainingTableName: 'training-table',
      platformTableName: 'platform-table',
    });
  });

  it('throws when PERSONNEL_TABLE_NAME is missing (empty/absent-input row)', async () => {
    const { readGrantsReportConfig } = await import('./client.js');
    expect(() =>
      readGrantsReportConfig({
        TRAINING_DYNAMO_TABLE_NAME: 'training-table',
        PLATFORM_TABLE_NAME: 'platform-table',
      }),
    ).toThrow('PERSONNEL_TABLE_NAME is required');
  });

  it('throws when TRAINING_DYNAMO_TABLE_NAME is missing', async () => {
    const { readGrantsReportConfig } = await import('./client.js');
    expect(() =>
      readGrantsReportConfig({
        PERSONNEL_TABLE_NAME: 'personnel-table',
        PLATFORM_TABLE_NAME: 'platform-table',
      }),
    ).toThrow('TRAINING_DYNAMO_TABLE_NAME is required');
  });

  it('throws when PLATFORM_TABLE_NAME is missing', async () => {
    const { readGrantsReportConfig } = await import('./client.js');
    expect(() =>
      readGrantsReportConfig({
        PERSONNEL_TABLE_NAME: 'personnel-table',
        TRAINING_DYNAMO_TABLE_NAME: 'training-table',
      }),
    ).toThrow('PLATFORM_TABLE_NAME is required');
  });
});

describe('createDynamoClient', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PERSONNEL_TABLE_NAME = 'personnel-table';
    process.env.TRAINING_DYNAMO_TABLE_NAME = 'training-table';
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws (fail-closed) instead of returning a client when config is missing', async () => {
    delete process.env.PLATFORM_TABLE_NAME;
    const { createDynamoClient } = await import('./client.js');
    expect(() => createDynamoClient(process.env)).toThrow('PLATFORM_TABLE_NAME is required');
  });

  it('constructs a client once and reuses the same instance across calls', async () => {
    const { createDynamoClient } = await import('./client.js');
    const fakeClient = {} as DynamoDBDocumentClient;
    const first = createDynamoClient(process.env, fakeClient);
    const second = createDynamoClient(process.env);
    expect(first).toBe(fakeClient);
    expect(second).toBe(fakeClient);
  });

  it('builds a real X-Ray-instrumented DynamoDBDocumentClient when no override client is given (production wiring path)', async () => {
    const { createDynamoClient } = await import('./client.js');
    const client = createDynamoClient(process.env);
    expect(client).toBeInstanceOf(DynamoDBDocumentClient);
  });
});
