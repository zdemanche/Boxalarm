import { PutCommand } from '@aws-sdk/lib-dynamodb';
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
  body: unknown,
  groups = 'ADMIN',
  headers: Record<string, string | undefined> = {},
): APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext> {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/inventory/equipment',
    rawPath: '/api/v1/inventory/equipment',
    rawQueryString: '',
    headers,
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

describe('handler (POST /api/v1/inventory/equipment)', () => {
  it('AC1: creates an asset and returns it unassigned by default (entrypoint-test)', async () => {
    const client = fakeDocClient((command) => {
      expect(command).toBeInstanceOf(PutCommand);
      return {};
    });
    const result = await handler(
      event({ serialNumber: 'SN-1', location: 'Station 1' }),
      undefined,
      undefined,
      ENV,
      client,
    );
    expect(result.statusCode).toBe(201);
    const asset = JSON.parse(result.body ?? '{}') as Record<string, unknown>;
    expect(asset.serialNumber).toBe('SN-1');
    expect(asset.assignedToType).toBeUndefined();
  });

  it('400 problem+json when serialNumber is missing/empty', async () => {
    const client = fakeDocClient(() => ({}));
    const result = await handler(event({ serialNumber: '  ' }), undefined, undefined, ENV, client);
    expect(result.statusCode).toBe(400);
    expect(result.headers?.['content-type']).toBe('application/problem+json');
  });

  it('403 problem+json when the caller lacks ADMIN/CHIEF/OFFICER', async () => {
    const client = fakeDocClient(() => ({}));
    const result = await handler(
      event({ serialNumber: 'SN-1' }, 'MEMBER'),
      undefined,
      undefined,
      ENV,
      client,
    );
    expect(result.statusCode).toBe(403);
  });

  it('500 problem+json, fail-closed, when the DynamoDB PutCommand throws (dependency unavailable)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakeDocClient(() => {
      throw new Error('ProvisionedThroughputExceededException');
    });
    const result = await handler(
      event({ serialNumber: 'SN-1' }),
      undefined,
      undefined,
      ENV,
      client,
    );
    expect(result.statusCode).toBe(500);
    // error-path-logging: the original error is logged, not silently swallowed.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('ProvisionedThroughputExceededException'),
    );
  });

  it('business-metrics: emits an EquipmentAssetCreated metric on success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const client = fakeDocClient(() => ({}));
    await handler(event({ serialNumber: 'SN-1' }), undefined, undefined, ENV, client);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('EquipmentAssetCreated'));
  });

  it('traceparent: propagates a valid incoming traceparent header on success', async () => {
    const client = fakeDocClient(() => ({}));
    const result = await handler(
      event({ serialNumber: 'SN-1' }, 'ADMIN', {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      }),
      undefined,
      undefined,
      ENV,
      client,
    );
    expect(result.headers?.traceparent).toBe(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    );
  });

  it('traceparent: generates a fresh valid traceparent (root span) when no header is sent', async () => {
    const client = fakeDocClient(() => ({}));
    const result = await handler(
      event({ serialNumber: 'SN-1' }),
      undefined,
      undefined,
      ENV,
      client,
    );
    expect(result.headers?.traceparent).toMatch(/^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/);
  });

  it('traceparent: still returned on the error path (400)', async () => {
    const client = fakeDocClient(() => ({}));
    const result = await handler(event({ serialNumber: '  ' }), undefined, undefined, ENV, client);
    expect(result.headers?.traceparent).toMatch(/^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/);
  });
});
