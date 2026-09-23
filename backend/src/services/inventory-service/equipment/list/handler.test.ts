import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayRequestAuthorizerEventV2,
} from 'aws-lambda';
import type { AuthorizerContext } from '../../../platform-service/authorizer/handler.js';
import { handler } from './handler.js';

const ENV = { PLATFORM_TABLE_NAME: 'boxalarm-platform' };

function event(
  query: Record<string, string> | undefined,
): APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext> {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/inventory/equipment',
    rawPath: '/api/v1/inventory/equipment',
    rawQueryString: '',
    headers: {},
    queryStringParameters: query,
    requestContext: {
      requestId: 'req-1',
      authorizer: { lambda: { sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': '' } },
    } as unknown as APIGatewayRequestAuthorizerEventV2['requestContext'],
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;
}

function fakeDocClient(send: (command: unknown) => unknown): DynamoDBDocumentClient {
  return {
    send: vi.fn((command: unknown) => Promise.resolve(send(command))),
  } as unknown as DynamoDBDocumentClient;
}

describe('handler (GET /api/v1/inventory/equipment)', () => {
  it('AC1: lists the department-wide registry by default (entrypoint-test)', async () => {
    const client = fakeDocClient((command) => {
      expect(command).toBeInstanceOf(QueryCommand);
      return {
        Items: [
          {
            assetId: 'AS-1',
            deptId: 'NICHOLS',
            serialNumber: 'SN-1',
            location: 'x',
            lifecycleStatus: 'ACQUIRED',
          },
        ],
      };
    });
    const result = await handler(event(undefined), undefined, undefined, ENV, client);
    expect(result.statusCode).toBe(200);
    expect((JSON.parse(result.body ?? '{}') as { items: unknown[] }).items).toHaveLength(1);
  });

  it('AC2: an apparatus-filtered query is passed through to the repository', async () => {
    const client = fakeDocClient((command) => {
      const input = (command as QueryCommand).input;
      expect(input.ExpressionAttributeValues?.[':type']).toBe('APPARATUS');
      return { Items: [] };
    });
    await handler(
      event({ assignedToType: 'APPARATUS', assignedToId: 'APP-1' }),
      undefined,
      undefined,
      ENV,
      client,
    );
  });
});
