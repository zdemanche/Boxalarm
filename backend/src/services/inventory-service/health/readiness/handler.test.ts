import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler } from './handler.js';

const ENV = { PLATFORM_TABLE_NAME: 'boxalarm-platform' };

function fakeClient(send: (command: unknown) => unknown): DynamoDBClient {
  return {
    send: vi.fn((command: unknown) => Promise.resolve(send(command))),
  } as unknown as DynamoDBClient;
}

describe('handler (GET /api/v1/inventory/health/readiness)', () => {
  it('returns 200 ready when DescribeTableCommand succeeds (readiness-both-ways: success, entrypoint-test)', async () => {
    const client = fakeClient(() => ({}));
    const result = await handler({} as APIGatewayProxyEventV2, undefined, undefined, ENV, client);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ status: 'ready' });
  });

  it('returns 503 not-ready when DescribeTableCommand throws (readiness-both-ways: failure)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakeClient(() => {
      throw new Error('DynamoDB unavailable');
    });
    const result = await handler({} as APIGatewayProxyEventV2, undefined, undefined, ENV, client);
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ status: 'not-ready' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DynamoDB unavailable'));
  });
});
