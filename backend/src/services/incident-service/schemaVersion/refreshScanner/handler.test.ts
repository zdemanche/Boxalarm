import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledEvent } from 'aws-lambda';
import { CORE_SCHEMA_V_N, SECONDARY_SCHEMA_V_N } from '../fixtures.js';

const ORIGINAL_ENV = { ...process.env };

function scheduledEvent(): ScheduledEvent {
  return { id: 'evt-1' } as ScheduledEvent;
}

describe('schemaVersion refreshScanner', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      INCIDENT_TABLE_NAME: 'boxalarm-dev-incident',
      NERIS_SCHEMA_BUCKET_NAME: 'boxalarm-dev-neris-schema',
      NERIS_SCHEMA_SOURCE_URL: 'https://schema.example.com/latest.json',
    };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it('pins the fetched Core/Secondary schema to S3 and publishes a new ACTIVE SCHEMA_VERSION without any deploy (AC1)', async () => {
    const { runSchemaVersionRefresh } = await import('./handler.js');
    const s3Send = vi.fn().mockResolvedValue({});
    const ddbSend = vi.fn().mockResolvedValue({});
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          version: '2026.2',
          core: CORE_SCHEMA_V_N,
          secondary: SECONDARY_SCHEMA_V_N,
        }),
    });

    await runSchemaVersionRefresh('corr-1', {
      s3Client: { send: s3Send } as never,
      dynamoClient: { send: ddbSend } as never,
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => 1_798_000_000,
    });

    expect(s3Send).toHaveBeenCalledTimes(2);
    expect(ddbSend).toHaveBeenCalledTimes(1);
    const [publishCommand] = ddbSend.mock.calls[0] as [
      { input: { TransactItems: { Put: { Item: Record<string, unknown> } }[] } },
    ];
    expect(publishCommand.input.TransactItems[0]?.Put.Item).toMatchObject({
      version: '2026.2',
      status: 'ACTIVE',
    });
  });

  it('surfaces a malformed upstream feed as a scan failure rather than publishing a broken version', async () => {
    const { runSchemaVersionRefresh } = await import('./handler.js');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    await expect(
      runSchemaVersionRefresh('corr-2', {
        s3Client: { send: vi.fn() } as never,
        dynamoClient: { send: vi.fn() } as never,
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/shape validation/);
  });

  it('exports a scheduled-event handler that delegates to the scan with the event id as correlationId', async () => {
    vi.resetModules();
    vi.doMock('../repository.js', () => ({
      createSchemaVersionRepository: () => ({
        publishSchemaVersion: vi.fn().mockResolvedValue({}),
      }),
      DuplicateSchemaVersionError: class extends Error {},
    }));
    vi.doMock('../../repository.js', () => ({
      getDocumentClient: () => ({ send: vi.fn().mockResolvedValue({}) }),
      getTableName: () => 'boxalarm-dev-incident',
    }));
    vi.doMock('../../../platform-service/export/awsClients.js', () => ({
      getS3Client: () => ({ send: vi.fn().mockResolvedValue({}) }),
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            version: '2026.2',
            core: CORE_SCHEMA_V_N,
            secondary: SECONDARY_SCHEMA_V_N,
          }),
      }),
    );

    const { handler } = await import('./handler.js');
    await expect(handler(scheduledEvent(), {} as never, () => undefined)).resolves.toBeUndefined();

    vi.unstubAllGlobals();
    vi.doUnmock('../repository.js');
    vi.doUnmock('../../repository.js');
    vi.doUnmock('../../../platform-service/export/awsClients.js');
  });
});
