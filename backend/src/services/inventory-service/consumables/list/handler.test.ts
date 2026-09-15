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
  authorizerContext: Record<string, unknown> | undefined,
): APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext> {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/inventory/consumables',
    rawPath: '/api/v1/inventory/consumables',
    rawQueryString: '',
    headers: {},
    queryStringParameters: undefined,
    requestContext: {
      requestId: 'req-1',
      authorizer: { lambda: authorizerContext },
    } as unknown as APIGatewayRequestAuthorizerEventV2['requestContext'],
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;
}

function fakeDocClient(send: (command: unknown) => unknown): DynamoDBDocumentClient {
  return {
    send: vi.fn((command: unknown) => Promise.resolve(send(command))),
  } as unknown as DynamoDBDocumentClient;
}

describe('handler (GET /api/v1/inventory/consumables, entrypoint-test)', () => {
  it('AC1: returns 200 with items at/below threshold flagged distinctly from adequate stock', async () => {
    const client = fakeDocClient((command) => {
      expect(command).toBeInstanceOf(QueryCommand);
      return {
        Items: [
          {
            entityType: 'CONSUMABLE_STOCK',
            itemId: 'GLOVES-L',
            deptId: 'NICHOLS',
            itemName: 'Gloves (Large)',
            stockLevel: 3,
            reorderThreshold: 5,
          },
          {
            entityType: 'CONSUMABLE_STOCK',
            itemId: 'STRAPS-M',
            deptId: 'NICHOLS',
            itemName: 'Straps (Medium)',
            stockLevel: 20,
            reorderThreshold: 5,
          },
        ],
      };
    });

    const result = await handler(
      event({ sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': '' }),
      undefined,
      undefined,
      ENV,
      client,
    );

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body ?? '{}') as {
      items: { itemId: string; reorderFlagged: boolean }[];
    };
    expect(body.items.find((item) => item.itemId === 'GLOVES-L')?.reorderFlagged).toBe(true);
    expect(body.items.find((item) => item.itemId === 'STRAPS-M')?.reorderFlagged).toBe(false);
  });

  it('AC1: returns 200 with an empty list for a department with no consumable items', async () => {
    const client = fakeDocClient(() => ({ Items: [] }));

    const result = await handler(
      event({ sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': '' }),
      undefined,
      undefined,
      ENV,
      client,
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ items: [] });
  });

  it('returns a 500 problem response when the authorizer context carries no verified deptId', async () => {
    const client = fakeDocClient(() => ({ Items: [] }));

    const result = await handler(event(undefined), undefined, undefined, ENV, client);

    expect(result.statusCode).toBe(500);
    expect(result.headers?.['content-type']).toBe('application/problem+json');
  });

  it('returns a 500 problem response when the DynamoDB query fails (fail-closed)', async () => {
    const client = fakeDocClient(() => {
      throw new Error('DynamoDB unavailable');
    });

    const result = await handler(
      event({ sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': '' }),
      undefined,
      undefined,
      ENV,
      client,
    );

    expect(result.statusCode).toBe(500);
  });
});
