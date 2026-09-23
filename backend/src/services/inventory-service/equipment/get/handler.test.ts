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
): APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext> {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/inventory/equipment/{assetId}',
    rawPath: `/api/v1/inventory/equipment/${assetId ?? ''}`,
    rawQueryString: '',
    headers: {},
    pathParameters: assetId ? { assetId } : undefined,
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

describe('handler (GET /api/v1/inventory/equipment/{assetId})', () => {
  it('AC2: returns assignedToType/assignedToId reflected for the asset (entrypoint-test)', async () => {
    const client = fakeDocClient(() => ({
      Item: {
        assetId: 'AS-1',
        deptId: 'NICHOLS',
        serialNumber: 'SN-1',
        assignedToType: 'MEMBER',
        assignedToId: 'MBR-1',
        location: 'Station 1',
        lifecycleStatus: 'ACQUIRED',
      },
    }));
    const result = await handler(event('AS-1'), undefined, undefined, ENV, client);
    expect(result.statusCode).toBe(200);
    const asset = JSON.parse(result.body ?? '{}') as Record<string, unknown>;
    expect(asset.assignedToType).toBe('MEMBER');
    expect(asset.assignedToId).toBe('MBR-1');
  });

  it('404 problem+json when assetId is not found', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakeDocClient(() => ({ Item: undefined }));
    const result = await handler(event('missing'), undefined, undefined, ENV, client);
    expect(result.statusCode).toBe(404);
    expect(result.headers?.['content-type']).toBe('application/problem+json');
    expect(errorSpy).toHaveBeenCalled();
  });
});
