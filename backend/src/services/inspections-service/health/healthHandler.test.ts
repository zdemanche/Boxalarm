import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { livenessHandler, readinessHandler } from './healthHandler.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  process.env.PLATFORM_TABLE_NAME = 'boxalarm-platform-table';
});

describe('livenessHandler (entrypoint)', () => {
  it('returns 200 unconditionally', async () => {
    const result = (await livenessHandler({} as never, {} as never, () => undefined)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(200);
  });
});

describe('readinessHandler (entrypoint)', () => {
  it('returns 200 when DynamoDB is reachable', async () => {
    ddbMock.on(DescribeTableCommand).resolves({});
    const result = (await readinessHandler({} as never, {} as never, () => undefined)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(200);
  });

  it('returns 503 when DynamoDB is unreachable', async () => {
    ddbMock.on(DescribeTableCommand).rejects(new Error('simulated outage'));
    const result = (await readinessHandler({} as never, {} as never, () => undefined)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(503);
  });
});
