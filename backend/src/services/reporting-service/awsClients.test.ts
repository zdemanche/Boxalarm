import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { readReportingServiceConfig } from './awsClients.js';

describe('readReportingServiceConfig', () => {
  it('throws when PLATFORM_SERVICE_TABLE_NAME is missing', () => {
    expect(() => readReportingServiceConfig({})).toThrow(/PLATFORM_SERVICE_TABLE_NAME/);
  });

  it('returns tableName when set', () => {
    const config = readReportingServiceConfig({ PLATFORM_SERVICE_TABLE_NAME: 'platform-table' });
    expect(config).toEqual({ tableName: 'platform-table' });
  });
});

describe('createDynamoDocClient', () => {
  it('returns the injected client and caches it across calls', async () => {
    vi.resetModules();
    const { createDynamoDocClient } = await import('./awsClients.js');
    const injected = {} as DynamoDBDocumentClient;
    expect(createDynamoDocClient(injected)).toBe(injected);
    expect(createDynamoDocClient()).toBe(injected);
  });
});
