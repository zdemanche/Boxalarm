import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

function fakeMiddlewareStack() {
  return { use: () => undefined, remove: () => undefined };
}

function mockDynamoDBClient(send: (command: unknown) => Promise<unknown>): void {
  vi.doMock('@aws-sdk/client-dynamodb', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
    class FakeDynamoDBClient {
      middlewareStack = fakeMiddlewareStack();
      config = {};
      send = send;
    }
    return { ...actual, DynamoDBClient: FakeDynamoDBClient };
  });
}

function buildEvent(): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/api/v1/inspections/health/readiness',
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    requestContext: {
      requestId: 'trace-health-1',
    } as unknown as APIGatewayProxyEventV2['requestContext'],
  };
}

describe('inspections-service health handlers', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.OCCUPANCY_TABLE_NAME = 'boxalarm-test-platform-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unmock('@aws-sdk/client-dynamodb');
    vi.restoreAllMocks();
  });

  it('livenessHandler always returns 200 with no dependency check', async () => {
    const { livenessHandler } = await import('./handler.js');
    const result = (await livenessHandler(
      buildEvent(),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(200);
  });

  it('readinessHandler returns 200 when DynamoDB DescribeTable succeeds', async () => {
    mockDynamoDBClient(() => Promise.resolve({ Table: { TableStatus: 'ACTIVE' } }));
    const { readinessHandler } = await import('./handler.js');
    const result = (await readinessHandler(
      buildEvent(),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(200);
  });

  it('readinessHandler returns 503 when DynamoDB is unreachable', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockDynamoDBClient(() => Promise.reject(new Error('ddb unavailable')));
    const { readinessHandler } = await import('./handler.js');
    const result = (await readinessHandler(
      buildEvent(),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(503);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('inspections.readiness.failed'));
  });
});
