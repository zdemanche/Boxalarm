import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledEvent } from 'aws-lambda';
import { CORE_SCHEMA_V_N, SECONDARY_SCHEMA_V_N } from '../fixtures.js';

const ORIGINAL_ENV = { ...process.env };

const OPENAPI = {
  info: { version: '1.5.1' },
  components: {
    schemas: {
      IncidentPayload: { type: 'object', properties: {}, required: [] },
      TypeIncidentValue: {
        enum: ['FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE', 'NOEMERG||CANCELLED'],
      },
    },
  },
};

/** Feed at the source URL, the NERIS OpenAPI document at the NERIS URL. */
function fetchBoth(feed: unknown) {
  return vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.includes('openapi') ? OPENAPI : feed),
    }),
  );
}

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
      NERIS_OPENAPI_URL: 'https://api-test.neris.fsri.org/v1/openapi.json',
      NERIS_USER_AGENT: 'Boxalarm/dev',
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
    const fetchFn = fetchBoth({
      version: '2026.2',
      core: CORE_SCHEMA_V_N,
      secondary: SECONDARY_SCHEMA_V_N,
    });

    await runSchemaVersionRefresh('corr-1', {
      s3Client: { send: s3Send } as never,
      dynamoClient: { send: ddbSend } as never,
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => 1_798_000_000,
    });

    expect(s3Send).toHaveBeenCalledTimes(3);
    expect(ddbSend).toHaveBeenCalledTimes(1);
    const bodies = s3Send.mock.calls.map(
      ([c]) => (c as { input: { Key: string; Body: string } }).input,
    );
    const core = JSON.parse(bodies.find((b) => b.Key.endsWith('core.json'))!.Body) as {
      enumerations: Record<string, string[]>;
    };
    // The incident-type list is NERIS's TypeIncidentValue, not the feed's local list.
    expect(core.enumerations.incident_type).toEqual([
      'FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE',
      'NOEMERG||CANCELLED',
    ]);
    expect(bodies.map((b) => b.Key)).toContain('neris-schema/2026.2+neris-1.5.1/neris-api.json');
    expect(fetchFn).toHaveBeenCalledWith('https://api-test.neris.fsri.org/v1/openapi.json', {
      headers: { 'User-Agent': 'Boxalarm/dev' },
    });
    const [publishCommand] = ddbSend.mock.calls[0] as [
      { input: { TransactItems: { Put: { Item: Record<string, unknown> } }[] } },
    ];
    expect(publishCommand.input.TransactItems[0]?.Put.Item).toMatchObject({
      version: '2026.2+neris-1.5.1',
      status: 'ACTIVE',
      nerisApiS3Key: 'neris-schema/2026.2+neris-1.5.1/neris-api.json',
    });
  });

  it('surfaces a malformed upstream feed as a scan failure rather than publishing a broken version', async () => {
    const { runSchemaVersionRefresh } = await import('./handler.js');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchFn = fetchBoth({});

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
      fetchBoth({ version: '2026.2', core: CORE_SCHEMA_V_N, secondary: SECONDARY_SCHEMA_V_N }),
    );

    const { handler } = await import('./handler.js');
    await expect(handler(scheduledEvent(), {} as never, () => undefined)).resolves.toBeUndefined();

    vi.unstubAllGlobals();
    vi.doUnmock('../repository.js');
    vi.doUnmock('../../repository.js');
    vi.doUnmock('../../../platform-service/export/awsClients.js');
  });

  it('fails the refresh (keeping the previous pin active) when the NERIS OpenAPI document is unusable', async () => {
    const { runSchemaVersionRefresh } = await import('./handler.js');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchFn = vi.fn((url: string) =>
      Promise.resolve(
        url.includes('openapi')
          ? { ok: false, status: 403, json: () => Promise.resolve({}) }
          : {
              ok: true,
              json: () =>
                Promise.resolve({
                  version: '2026.2',
                  core: CORE_SCHEMA_V_N,
                  secondary: SECONDARY_SCHEMA_V_N,
                }),
            },
      ),
    );
    const ddbSend = vi.fn();
    await expect(
      runSchemaVersionRefresh('corr-3', {
        s3Client: { send: vi.fn() } as never,
        dynamoClient: { send: ddbSend } as never,
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/OpenAPI document returned 403/);
    expect(ddbSend).not.toHaveBeenCalled();
  });
});
