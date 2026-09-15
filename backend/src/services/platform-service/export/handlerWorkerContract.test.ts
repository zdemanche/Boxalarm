import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import type { AuthorizerContext } from '../authorizer/handler.js';
import type { ExportWorkerEvent } from './worker.js';

// handler.ts and worker.ts are separate Lambdas, wired only by an async InvokeCommand —
// nothing else in this test suite proves the payload handler.ts actually sends is one
// worker.ts can consume. A change to either side's shape (e.g. renaming `deptId`) would
// pass both files' own unit tests in isolation while breaking the real invoke at runtime.
describe('export handler -> worker invoke contract', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
    process.env.EXPORT_BUCKET_NAME = 'boxalarm-exports-staging';
    process.env.EXPORT_WORKER_FUNCTION_NAME = 'export-worker';
    process.env.ALERTING_TABLE_NAME = 'alerting-service';
    process.env.INCIDENT_TABLE_NAME = 'incident-service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('sends a worker InvokeCommand payload that worker.ts accepts and runs without error', async () => {
    const { createHandler } = await import('./handler.js');
    let capturedPayload: ExportWorkerEvent | undefined;
    const handlerLambdaClient = {
      send: vi.fn((command: { input: { Payload: Uint8Array } }) => {
        capturedPayload = JSON.parse(
          Buffer.from(command.input.Payload).toString('utf8'),
        ) as ExportWorkerEvent;
        return Promise.resolve({});
      }),
    } as never;

    const handler = createHandler({
      docClient: { send: vi.fn().mockResolvedValue({}) } as never,
      lambdaClient: handlerLambdaClient,
    });
    const event: APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext> = {
      version: '2.0',
      routeKey: 'POST /api/v1/platform/export',
      rawPath: '/api/v1/platform/export',
      rawQueryString: '',
      headers: {},
      isBase64Encoded: false,
      requestContext: {
        accountId: '111122223333',
        apiId: 'api-id',
        domainName: 'api.example.com',
        domainPrefix: 'api',
        http: {
          method: 'POST',
          path: '/api/v1/platform/export',
          protocol: 'HTTP/1.1',
          sourceIp: '127.0.0.1',
          userAgent: 'test',
        },
        requestId: 'req-1',
        routeKey: 'POST /api/v1/platform/export',
        stage: '$default',
        time: '1/1/2026',
        timeEpoch: Date.now(),
        authorizer: {
          lambda: { sub: 'member-0012', deptId: 'dept-001', 'cognito:groups': 'ADMIN' },
        },
      },
    };

    await handler(event, {} as never, () => undefined);

    expect(capturedPayload).toBeDefined();
    expect(typeof capturedPayload?.jobId).toBe('string');
    expect(capturedPayload?.deptId).toBe('dept-001');

    // Feed the exact captured payload into the real worker handler — proves the
    // contract holds end to end, not just that each side's own shape looks plausible.
    const { createHandler: createWorkerHandler } = await import('./worker.js');
    const scanCalls: unknown[] = [];
    const workerHandler = createWorkerHandler({
      docClient: {
        send: vi.fn((command: unknown) => {
          scanCalls.push(command);
          return Promise.resolve({ Items: [] });
        }),
      } as never,
      s3Client: { send: vi.fn().mockResolvedValue({ ETag: 'etag-1' }) } as never,
    });

    await expect(
      workerHandler(capturedPayload as ExportWorkerEvent, {} as never, () => undefined),
    ).resolves.not.toThrow();
    expect(scanCalls.length).toBeGreaterThan(0);
  });
});
