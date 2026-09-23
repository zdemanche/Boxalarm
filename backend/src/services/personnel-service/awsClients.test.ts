import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { readPersonnelServiceConfig } from './awsClients.js';

describe('readPersonnelServiceConfig', () => {
  it('throws when PERSONNEL_TABLE_NAME is missing', () => {
    expect(() => readPersonnelServiceConfig({ PLATFORM_BUS_NAME: 'bus' })).toThrow(
      /PERSONNEL_TABLE_NAME/,
    );
  });

  it('throws when PLATFORM_BUS_NAME is missing', () => {
    expect(() => readPersonnelServiceConfig({ PERSONNEL_TABLE_NAME: 'table' })).toThrow(
      /PLATFORM_BUS_NAME/,
    );
  });

  it('returns tableName and busName when both are set', () => {
    const config = readPersonnelServiceConfig({
      PERSONNEL_TABLE_NAME: 'table',
      PLATFORM_BUS_NAME: 'bus',
    });
    expect(config).toEqual({ tableName: 'table', busName: 'bus' });
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

describe('createEventBridgeClient', () => {
  it('returns the injected client and caches it across calls', async () => {
    vi.resetModules();
    const { createEventBridgeClient } = await import('./awsClients.js');
    const injected = {} as EventBridgeClient;
    expect(createEventBridgeClient(injected)).toBe(injected);
    expect(createEventBridgeClient()).toBe(injected);
  });
});
