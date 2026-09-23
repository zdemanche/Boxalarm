import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

describe('readPersonnelConfig', () => {
  it('reads the table name', async () => {
    const { readPersonnelConfig } = await import('./dynamoClient.js');
    expect(readPersonnelConfig({ PERSONNEL_TABLE_NAME: 'personnel-table' })).toEqual({
      tableName: 'personnel-table',
    });
  });

  it('throws when PERSONNEL_TABLE_NAME is missing (empty/absent-input row)', async () => {
    const { readPersonnelConfig } = await import('./dynamoClient.js');
    expect(() => readPersonnelConfig({})).toThrow('PERSONNEL_TABLE_NAME is required');
  });
});

describe('readAttendanceTableConfig', () => {
  it('reads the table name', async () => {
    const { readAttendanceTableConfig } = await import('./dynamoClient.js');
    expect(readAttendanceTableConfig({ PLATFORM_SERVICE_TABLE_NAME: 'platform-service' })).toEqual({
      tableName: 'platform-service',
    });
  });

  it('throws when PLATFORM_SERVICE_TABLE_NAME is missing (empty/absent-input row)', async () => {
    const { readAttendanceTableConfig } = await import('./dynamoClient.js');
    expect(() => readAttendanceTableConfig({})).toThrow(
      'PLATFORM_SERVICE_TABLE_NAME is required and was not set',
    );
  });
});

describe('createDynamoClient', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PERSONNEL_TABLE_NAME = 'personnel-table';
    process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws (fail-closed) instead of returning a client when config is missing', async () => {
    delete process.env.PERSONNEL_TABLE_NAME;
    delete process.env.PLATFORM_SERVICE_TABLE_NAME;
    const { createDynamoClient } = await import('./dynamoClient.js');
    expect(() => createDynamoClient(process.env)).toThrow('PERSONNEL_TABLE_NAME is required');
  });

  it('constructs a client once and reuses the same instance across calls', async () => {
    const { createDynamoClient } = await import('./dynamoClient.js');
    const fakeClient = {} as DynamoDBDocumentClient;
    const first = createDynamoClient(process.env, fakeClient);
    const second = createDynamoClient(process.env);
    expect(first).toBe(fakeClient);
    expect(second).toBe(fakeClient);
  });

  it('constructs a real X-Ray-wrapped DynamoDBDocumentClient when none is injected', async () => {
    const { createDynamoClient } = await import('./dynamoClient.js');
    const client = createDynamoClient(process.env);
    expect(client).toBeInstanceOf(DynamoDBDocumentClient);
  });
});
