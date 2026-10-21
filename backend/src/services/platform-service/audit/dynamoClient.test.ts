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

  it('throws (fail-fast) when INCIDENT_AUDIT_TABLE_NAME is not set', async () => {
    process.env.AUDIT_TABLE_NAME = 'boxalarm-dev-platform';
    delete process.env.INCIDENT_AUDIT_TABLE_NAME;
    const { readAuditConfig } = await import('./dynamoClient.js');
    expect(() => readAuditConfig(process.env)).toThrow(/INCIDENT_AUDIT_TABLE_NAME/);
  });

  it('returns both table names when set', async () => {
    process.env.AUDIT_TABLE_NAME = 'boxalarm-dev-platform';
    process.env.INCIDENT_AUDIT_TABLE_NAME = 'boxalarm-dev-incident';
    const { readAuditConfig } = await import('./dynamoClient.js');
    expect(readAuditConfig(process.env)).toEqual({
      tableName: 'boxalarm-dev-platform',
      incidentTableName: 'boxalarm-dev-incident',
    });
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
