import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import type { AuthorizerContext } from '../authorizer/handler.js';

const DEPT_ID = 'dept-001';

function buildEvent(
  routeKey: string,
  context: Partial<AuthorizerContext> | undefined,
  pathParameters?: Record<string, string>,
): APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext> {
  return {
    version: '2.0',
    routeKey,
    rawPath: '/api/v1/platform/export',
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    ...(pathParameters !== undefined ? { pathParameters } : {}),
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: routeKey.split(' ')[0] ?? 'GET',
        path: '/api/v1/platform/export',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey,
      stage: '$default',
      time: '1/1/2026',
      timeEpoch: Date.now(),
      authorizer: { lambda: context as AuthorizerContext },
    },
  };
}

function adminContext(overrides: Partial<AuthorizerContext> = {}): AuthorizerContext {
  return { sub: 'member-0012', deptId: DEPT_ID, 'cognito:groups': 'ADMIN', ...overrides };
}

function fakeDocClient(sendImpl: (command: unknown) => unknown) {
  return { send: vi.fn(sendImpl) } as never;
}

function fakeS3Client(sendImpl: (command: unknown) => unknown) {
  return { send: vi.fn(sendImpl) } as never;
}

function fakeLambdaClient(sendImpl: (command: unknown) => unknown = () => ({})) {
  return { send: vi.fn(sendImpl) } as never;
}

describe('export handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
    process.env.EXPORT_BUCKET_NAME = 'boxalarm-exports-staging';
    process.env.EXPORT_WORKER_FUNCTION_NAME = 'export-worker';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('is exported as the real Lambda entrypoint and denies an absent authorizer context (entrypoint test)', async () => {
    const { handler } = await import('./handler.js');
    const event = buildEvent('POST /api/v1/platform/export', undefined);
    const result = (await handler(event, {} as never, () => undefined)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(401);
  });

  it('accepts (202) an admin on POST, writing EXPORT_JOB + AUDIT_LOG_ENTRY and emitting ExportInvoked (AC1, AC2)', async () => {
    const { createHandler } = await import('./handler.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const transactSend = vi.fn().mockResolvedValue({});
    const invokeSend = vi.fn().mockResolvedValue({});
    const handler = createHandler({
      docClient: fakeDocClient(transactSend),
      lambdaClient: fakeLambdaClient(invokeSend),
    });

    const result = (await handler(
      buildEvent('POST /api/v1/platform/export', adminContext()),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(202);
    expect(JSON.parse(result.body)).toEqual({ jobId: expect.any(String) as unknown });
    expect(transactSend).toHaveBeenCalledTimes(1);
    const transactItems = (
      transactSend.mock.calls[0]?.[0] as { input: { TransactItems: unknown[] } }
    ).input.TransactItems as { Put: { Item: Record<string, unknown> } }[];
    expect(transactItems.map((entry) => entry.Put.Item.entityType)).toEqual([
      'EXPORT_JOB',
      'AUDIT_LOG_ENTRY',
    ]);
    expect(invokeSend).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ExportInvoked'));
  });

  it('ignores the request body entirely and still returns 202 regardless of its shape', async () => {
    const { createHandler } = await import('./handler.js');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const handler = createHandler({
      docClient: fakeDocClient(() => ({})),
      lambdaClient: fakeLambdaClient(),
    });

    const event = buildEvent('POST /api/v1/platform/export', adminContext());
    const result = (await handler(
      { ...event, body: 'not json {{{' },
      {} as never,
      () => undefined,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(202);
  });

  it('denies (403) a valid session lacking CHIEF/ADMIN, never reaching DynamoDB (AC1 core-harm)', async () => {
    const { createHandler } = await import('./handler.js');
    const transactSend = vi.fn();
    const handler = createHandler({ docClient: fakeDocClient(transactSend) });

    const result = (await handler(
      buildEvent(
        'POST /api/v1/platform/export',
        adminContext({ 'cognito:groups': 'MEMBER OFFICER' }),
      ),
      {} as never,
      () => undefined,
    )) as { statusCode: number };

    expect(result.statusCode).toBe(403);
    expect(transactSend).not.toHaveBeenCalled();
  });

  it('denies (401) an authorizer context missing required fields, fail-closed, and logs it', async () => {
    const { createHandler } = await import('./handler.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = createHandler({});
    const result = (await handler(
      buildEvent('POST /api/v1/platform/export', { sub: 'member-1' }),
      {} as never,
      () => undefined,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(401);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('export.authorizerContext.invalid'),
    );
  });

  it('returns 503 (fail-closed, no 202) when the audited TransactWriteItems write fails', async () => {
    const { createHandler } = await import('./handler.js');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const invokeSend = vi.fn();
    const handler = createHandler({
      docClient: fakeDocClient(() => Promise.reject(new Error('DynamoDB unavailable'))),
      lambdaClient: fakeLambdaClient(invokeSend),
    });

    const result = (await handler(
      buildEvent('POST /api/v1/platform/export', adminContext()),
      {} as never,
      () => undefined,
    )) as { statusCode: number };

    expect(result.statusCode).toBe(503);
    expect(invokeSend).not.toHaveBeenCalled();
  });

  it('still returns 202 (detection already recorded) but marks the job FAILED and emits a metric when the worker invoke itself fails', async () => {
    const { createHandler } = await import('./handler.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const docSend = vi.fn().mockResolvedValue({});
    const handler = createHandler({
      docClient: fakeDocClient(docSend),
      lambdaClient: fakeLambdaClient(() => Promise.reject(new Error('Lambda unavailable'))),
    });

    const result = (await handler(
      buildEvent('POST /api/v1/platform/export', adminContext()),
      {} as never,
      () => undefined,
    )) as { statusCode: number };

    expect(result.statusCode).toBe(202);
    expect(docSend).toHaveBeenCalledTimes(2);
    const updateCall = docSend.mock.calls[1]?.[0] as { input: { UpdateExpression: string } };
    expect(updateCall.input.UpdateExpression).toContain(':failed');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ExportWorkerInvokeFailed'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('export.workerInvoke.failed'));
  });

  it('returns 404 for a GET on a jobId that does not exist for the caller deptId', async () => {
    const { createHandler } = await import('./handler.js');
    const handler = createHandler({ docClient: fakeDocClient(() => Promise.resolve({})) });

    const result = (await handler(
      buildEvent('GET /api/v1/platform/export/{jobId}', adminContext(), { jobId: 'missing' }),
      {} as never,
      () => undefined,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(404);
  });

  it('returns 403 for a GET from a non-admin/chief role', async () => {
    const { createHandler } = await import('./handler.js');
    const handler = createHandler({});
    const result = (await handler(
      buildEvent(
        'GET /api/v1/platform/export/{jobId}',
        adminContext({ 'cognito:groups': 'MEMBER' }),
        { jobId: 'job-1' },
      ),
      {} as never,
      () => undefined,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(403);
  });

  it('returns 200 PENDING when the job exists but the manifest has not landed yet', async () => {
    const { createHandler } = await import('./handler.js');
    const notFound = Object.assign(new Error('NotFound'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    const handler = createHandler({
      docClient: fakeDocClient(() => Promise.resolve({ Item: { status: 'PENDING' } })),
      s3Client: fakeS3Client(() => Promise.reject(notFound)),
    });

    const result = (await handler(
      buildEvent('GET /api/v1/platform/export/{jobId}', adminContext(), { jobId: 'job-1' }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ status: 'PENDING' });
  });

  it('returns 200 FAILED when the job status is FAILED (worker invoke never happened)', async () => {
    const { createHandler } = await import('./handler.js');
    const handler = createHandler({
      docClient: fakeDocClient(() => Promise.resolve({ Item: { status: 'FAILED' } })),
    });

    const result = (await handler(
      buildEvent('GET /api/v1/platform/export/{jobId}', adminContext(), { jobId: 'job-1' }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ status: 'FAILED' });
  });

  it('returns 200 FAILED via the S3 sentinel when the read-only worker failed mid-export (job status still PENDING)', async () => {
    const { createHandler } = await import('./handler.js');
    const notFound = Object.assign(new Error('NotFound'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    const handler = createHandler({
      docClient: fakeDocClient(() => Promise.resolve({ Item: { status: 'PENDING' } })),
      s3Client: fakeS3Client((command: unknown) => {
        const key = (command as { input: { Key: string } }).input.Key;
        if (key.endsWith('manifest.json')) {
          return Promise.reject(notFound);
        }
        if (key.endsWith('_failed.json')) {
          return Promise.resolve({});
        }
        return Promise.reject(new Error('unexpected key'));
      }),
    });

    const result = (await handler(
      buildEvent('GET /api/v1/platform/export/{jobId}', adminContext(), { jobId: 'job-1' }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ status: 'FAILED' });
  });

  it('returns 503 (not a silent PENDING) when the manifest HEAD fails for a reason other than not-found', async () => {
    const { createHandler } = await import('./handler.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const accessDenied = Object.assign(new Error('Access Denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    const handler = createHandler({
      docClient: fakeDocClient(() => Promise.resolve({ Item: { status: 'PENDING' } })),
      s3Client: fakeS3Client(() => Promise.reject(accessDenied)),
    });

    const result = (await handler(
      buildEvent('GET /api/v1/platform/export/{jobId}', adminContext(), { jobId: 'job-1' }),
      {} as never,
      () => undefined,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(503);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('export.manifestHead.failed'));
  });

  it('returns 503 with structured logging when GET hits an unexpected error (error boundary)', async () => {
    const { createHandler } = await import('./handler.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = createHandler({
      docClient: fakeDocClient(() => Promise.reject(new Error('DynamoDB unavailable'))),
    });

    const result = (await handler(
      buildEvent('GET /api/v1/platform/export/{jobId}', adminContext(), { jobId: 'job-1' }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(503);
    expect((JSON.parse(result.body) as { title: string }).title).toBe('Export unavailable');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('export.get.failed'));
  });

  it('returns 200 COMPLETE with a presigned URL per table once the manifest exists', async () => {
    vi.doMock('@aws-sdk/s3-request-presigner', () => ({
      getSignedUrl: vi
        .fn()
        .mockImplementation(
          (_client: unknown, command: { input: { Key: string } }) =>
            `https://signed.example/${command.input.Key}`,
        ),
    }));
    vi.resetModules();
    const { createHandler } = await import('./handler.js');

    const manifest = {
      jobId: 'job-1',
      deptId: DEPT_ID,
      tables: ['alerting-service', 'incident-service', 'platform-service'],
      itemCounts: { 'alerting-service': 0, 'incident-service': 1, 'platform-service': 2 },
      completedAt: '2026-09-14T00:00:00.000Z',
    };
    const handler = createHandler({
      docClient: fakeDocClient(() => Promise.resolve({ Item: { status: 'PENDING' } })),
      s3Client: fakeS3Client((command: unknown) => {
        const key = (command as { input: { Key: string } }).input.Key;
        if (key.endsWith('manifest.json')) {
          if (
            (command as { constructor: { name: string } }).constructor.name === 'HeadObjectCommand'
          ) {
            return Promise.resolve({});
          }
          return Promise.resolve({
            Body: { transformToString: () => Promise.resolve(JSON.stringify(manifest)) },
          });
        }
        return Promise.reject(new Error('unexpected key'));
      }),
    });

    const result = (await handler(
      buildEvent('GET /api/v1/platform/export/{jobId}', adminContext(), { jobId: 'job-1' }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as {
      status: string;
      files: { table: string; url: string }[];
    };
    expect(body.status).toBe('COMPLETE');
    expect(body.files).toHaveLength(3);
    expect(body.files[0]?.url).toContain('https://signed.example/');
    vi.doUnmock('@aws-sdk/s3-request-presigner');
  });
});
