import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

function buildEvent(path: string): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: `GET ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    requestContext: {
      http: { method: 'GET', path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: '' },
      requestId: 'req-1',
    } as unknown as APIGatewayProxyEventV2['requestContext'],
  };
}

describe('reporting-service health handler', () => {
  const originalEnv = { ...process.env };
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-table';
    mockSend = vi.spyOn(DynamoDBClient.prototype, 'send') as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('returns 200 for liveness always', async () => {
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent('/api/v1/reporting/health/liveness'),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('returns 200 for readiness when DescribeTable succeeds', async () => {
    mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } });
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent('/api/v1/reporting/health/readiness'),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('returns 503 for readiness when DescribeTable throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockSend.mockRejectedValueOnce(new Error('describe table failed'));
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent('/api/v1/reporting/health/readiness'),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('describe table failed'));
  });
});
