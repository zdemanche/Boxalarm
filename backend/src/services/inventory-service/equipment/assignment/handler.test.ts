import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
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
  assetId: string | undefined,
  body: unknown,
  groups = 'ADMIN',
): APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext> {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/inventory/equipment/{assetId}/assignment',
    rawPath: `/api/v1/inventory/equipment/${assetId ?? ''}/assignment`,
    rawQueryString: '',
    headers: {},
    pathParameters: assetId ? { assetId } : undefined,
    requestContext: {
      requestId: 'req-1',
      authorizer: { lambda: { sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': groups } },
    } as unknown as APIGatewayRequestAuthorizerEventV2['requestContext'],
    body: JSON.stringify(body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;
}

function fakeDocClient(send: (command: unknown) => unknown): DynamoDBDocumentClient {
  return {
    send: vi.fn((command: unknown) => Promise.resolve(send(command))),
  } as unknown as DynamoDBDocumentClient;
}

describe('handler (PUT /api/v1/inventory/equipment/{assetId}/assignment)', () => {
  it('AC2: assigns to a member and returns the updated asset (entrypoint-test)', async () => {
    const client = fakeDocClient(() => ({
      Attributes: {
        assetId: 'AS-1',
        deptId: 'NICHOLS',
        serialNumber: 'SN-1',
        assignedToType: 'MEMBER',
        assignedToId: 'MBR-1',
        location: 'Station 1',
        lifecycleStatus: 'ACQUIRED',
      },
    }));
    const result = await handler(
      event('AS-1', { assignedToType: 'MEMBER', assignedToId: 'MBR-1' }),
      undefined,
      undefined,
      ENV,
      client,
    );
    expect(result.statusCode).toBe(200);
    expect((JSON.parse(result.body ?? '{}') as Record<string, unknown>).assignedToType).toBe(
      'MEMBER',
    );
  });

  it('400 problem+json when assignedToType is not MEMBER|APPARATUS', async () => {
    const client = fakeDocClient(() => ({}));
    const result = await handler(
      event('AS-1', { assignedToType: 'ROBOT', assignedToId: 'X' }),
      undefined,
      undefined,
      ENV,
      client,
    );
    expect(result.statusCode).toBe(400);
  });

  it('400 problem+json when assignedToId is empty', async () => {
    const client = fakeDocClient(() => ({}));
    const result = await handler(
      event('AS-1', { assignedToType: 'MEMBER', assignedToId: '' }),
      undefined,
      undefined,
      ENV,
      client,
    );
    expect(result.statusCode).toBe(400);
  });

  it('404 problem+json when assetId is not found', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakeDocClient(() => {
      throw new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} });
    });
    const result = await handler(
      event('missing', { assignedToType: 'MEMBER', assignedToId: 'MBR-1' }),
      undefined,
      undefined,
      ENV,
      client,
    );
    expect(result.statusCode).toBe(404);
  });

  it('403 problem+json when the caller lacks ADMIN/CHIEF/OFFICER', async () => {
    const client = fakeDocClient(() => ({}));
    const result = await handler(
      event('AS-1', { assignedToType: 'MEMBER', assignedToId: 'MBR-1' }, 'MEMBER'),
      undefined,
      undefined,
      ENV,
      client,
    );
    expect(result.statusCode).toBe(403);
  });
});
