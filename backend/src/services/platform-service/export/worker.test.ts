import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DEPT_ID = 'dept-001';
const JOB_ID = 'job-1';

function fakeDocClient(itemsByTable: Record<string, Record<string, unknown>[]>) {
  return {
    send: vi.fn((command: { input: { TableName: string } }) => {
      const items = itemsByTable[command.input.TableName] ?? [];
      return Promise.resolve({ Items: items });
    }),
  } as never;
}

function fakeS3Client(putSend: (command: unknown) => unknown = () => Promise.resolve({})) {
  return { send: vi.fn(putSend) } as never;
}

describe('export worker', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.ALERTING_TABLE_NAME = 'alerting-service';
    process.env.INCIDENT_TABLE_NAME = 'incident-service';
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
    process.env.EXPORT_BUCKET_NAME = 'boxalarm-exports-staging';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.doUnmock('./awsClients.js');
    vi.resetModules();
  });

  it('is exported as the real Lambda entrypoint and completes via the real client factories (entrypoint test)', async () => {
    vi.doMock('./awsClients.js', () => ({
      getDynamoDocClient: () => fakeDocClient({}),
      getS3Client: () => fakeS3Client(),
    }));
    vi.resetModules();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { handler } = await import('./worker.js');
    await handler({ jobId: JOB_ID, deptId: DEPT_ID }, {} as never, () => undefined);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ExportCompleted'));
  });

  it('writes one NDJSON object per table plus a manifest spanning all three tables (AC3)', async () => {
    const { createHandler } = await import('./worker.js');
    const puts: { key: string; body: string }[] = [];
    const s3Client = fakeS3Client((command) => {
      const cmd = command as {
        constructor: { name: string };
        input: { Key?: string; Body?: string };
      };
      if (cmd.input.Key !== undefined) {
        puts.push({
          key: cmd.input.Key,
          body: typeof cmd.input.Body === 'string' ? cmd.input.Body : '',
        });
      }
      if (cmd.constructor.name === 'CreateMultipartUploadCommand') {
        return Promise.resolve({ UploadId: 'test-upload-id' });
      }
      if (cmd.constructor.name === 'UploadPartCommand') {
        return Promise.resolve({ ETag: 'etag' });
      }
      return Promise.resolve({});
    });
    const docClient = fakeDocClient({
      'alerting-service': [{ pk: `DEPT#${DEPT_ID}#DISPATCH#1`, sk: 'METADATA' }],
      'incident-service': [],
      'platform-service': [{ pk: `DEPT#${DEPT_ID}#MEMBER#1`, sk: 'METADATA' }],
    });
    const handler = createHandler({ docClient, s3Client });

    await handler({ jobId: JOB_ID, deptId: DEPT_ID }, {} as never, () => undefined);

    const manifestPut = puts.find((entry) => entry.key.endsWith('manifest.json'));
    expect(manifestPut).toBeDefined();
    const manifest = JSON.parse(manifestPut?.body ?? '{}') as {
      tables: string[];
      itemCounts: Record<string, number>;
    };
    expect(manifest.tables).toEqual(['alerting-service', 'incident-service', 'platform-service']);
    expect(manifest.itemCounts['incident-service']).toBe(0);
    expect(manifest.itemCounts['alerting-service']).toBe(1);

    const incidentPut = puts.find((entry) => entry.key.endsWith('incident-service.ndjson'));
    expect(incidentPut?.body).toBe('');
  });

  it('excludes a neighbouring department whose id is a prefix of this deptId (pk anchoring)', async () => {
    const { createHandler } = await import('./worker.js');
    const puts: { key: string; body: string }[] = [];
    const s3Client = fakeS3Client((command) => {
      const cmd = command as {
        constructor: { name: string };
        input: { Key?: string; Body?: string };
      };
      if (cmd.input.Key !== undefined) {
        puts.push({
          key: cmd.input.Key,
          body: typeof cmd.input.Body === 'string' ? cmd.input.Body : '',
        });
      }
      if (cmd.constructor.name === 'CreateMultipartUploadCommand') {
        return Promise.resolve({ UploadId: 'test-upload-id' });
      }
      if (cmd.constructor.name === 'UploadPartCommand') {
        return Promise.resolve({ ETag: 'etag' });
      }
      return Promise.resolve({});
    });

    const platformItems = [
      { pk: 'DEPT#dept-1#MEMBER#1', sk: 'METADATA' },
      { pk: 'DEPT#dept-1', sk: 'DEPARTMENT_CONFIG' },
      { pk: 'DEPT#dept-12#MEMBER#1', sk: 'METADATA' },
    ];
    const docClient = {
      send: vi.fn(
        (command: {
          input: {
            TableName: string;
            ExpressionAttributeValues: Record<string, string>;
          };
        }) => {
          const { TableName, ExpressionAttributeValues } = command.input;
          const items = TableName === 'platform-service' ? platformItems : [];
          const deptPk = ExpressionAttributeValues[':deptPk'];
          const deptPrefix = ExpressionAttributeValues[':deptPrefix'] ?? '';
          const filtered = items.filter(
            (item) => item.pk === deptPk || item.pk.startsWith(deptPrefix),
          );
          return Promise.resolve({ Items: filtered });
        },
      ),
    } as never;

    const handler = createHandler({ docClient, s3Client });
    await handler({ jobId: JOB_ID, deptId: 'dept-1' }, {} as never, () => undefined);

    const platformPuts = puts.filter((entry) => entry.key.endsWith('platform-service.ndjson'));
    const combinedBody = platformPuts.map((entry) => entry.body).join('');
    expect(combinedBody).not.toContain('dept-12');
    expect(combinedBody).toContain('DEPT#dept-1#MEMBER#1');
    expect(combinedBody).toContain('"DEPT#dept-1"');
  });

  it('logs the original error, emits ExportFailed, and never writes a manifest when a table Scan throws', async () => {
    const { createHandler } = await import('./worker.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const puts: string[] = [];
    const s3Client = fakeS3Client((command) => {
      puts.push((command as { input: { Key: string } }).input.Key);
      return Promise.resolve({});
    });
    const docClient = {
      send: vi.fn().mockRejectedValue(new Error('DynamoDB throttled')),
    } as never;
    const handler = createHandler({ docClient, s3Client });

    await handler({ jobId: JOB_ID, deptId: DEPT_ID }, {} as never, () => undefined);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('export.scan.failed'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(JOB_ID));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DynamoDB throttled'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ExportFailed'));
    expect(puts.some((key) => key.endsWith('manifest.json'))).toBe(false);
    expect(puts.some((key) => key.endsWith('_failed.json'))).toBe(true);
  });
});
