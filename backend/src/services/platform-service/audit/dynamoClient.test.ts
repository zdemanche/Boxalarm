import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('readAuditConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws (fail-fast) when AUDIT_TABLE_NAME is not set', async () => {
    delete process.env.AUDIT_TABLE_NAME;
    const { readAuditConfig, AuditConfigError } = await import('./dynamoClient.js');
    expect(() => readAuditConfig(process.env)).toThrow(/AUDIT_TABLE_NAME/);
    expect(() => readAuditConfig(process.env)).toThrow(AuditConfigError);
  });

  it('returns the table name when set', async () => {
    process.env.AUDIT_TABLE_NAME = 'boxalarm-dev-platform';
    const { readAuditConfig } = await import('./dynamoClient.js');
    expect(readAuditConfig(process.env)).toEqual({ tableName: 'boxalarm-dev-platform' });
  });
});

describe('getDocumentClient', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('constructs a DynamoDBDocumentClient once and reuses it across calls (lazy singleton)', async () => {
    const { getDocumentClient } = await import('./dynamoClient.js');
    const first = getDocumentClient();
    const second = getDocumentClient();
    expect(second).toBe(first);
  });
});
