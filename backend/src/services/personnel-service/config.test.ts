import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('personnel-service config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PLATFORM_TABLE_NAME;
    delete process.env.PLATFORM_BUS_NAME;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('readMemberServiceConfig throws when PLATFORM_TABLE_NAME is unset', async () => {
    const { readMemberServiceConfig } = await import('./config.js');
    expect(() => readMemberServiceConfig(process.env)).toThrow(
      'PLATFORM_TABLE_NAME is required and was not set',
    );
  });

  it('readMemberServiceConfig returns the table name when set', async () => {
    const { readMemberServiceConfig } = await import('./config.js');
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
    expect(readMemberServiceConfig(process.env)).toEqual({ tableName: 'platform-table' });
  });

  it('readOutboxPublisherConfig throws when PLATFORM_BUS_NAME is unset, even with a valid table name', async () => {
    const { readOutboxPublisherConfig } = await import('./config.js');
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
    expect(() => readOutboxPublisherConfig(process.env)).toThrow(
      'PLATFORM_BUS_NAME is required and was not set',
    );
  });

  it('readOutboxPublisherConfig throws PLATFORM_BUS_NAME first when neither is set', async () => {
    const { readOutboxPublisherConfig } = await import('./config.js');
    expect(() => readOutboxPublisherConfig(process.env)).toThrow(
      'PLATFORM_BUS_NAME is required and was not set',
    );
  });

  it('readOutboxPublisherConfig returns both values when set', async () => {
    const { readOutboxPublisherConfig } = await import('./config.js');
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
    process.env.PLATFORM_BUS_NAME = 'platform-bus';
    expect(readOutboxPublisherConfig(process.env)).toEqual({
      tableName: 'platform-table',
      busName: 'platform-bus',
    });
  });
});
