import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const originalEnv = { ...process.env };

const OFFICER: CedarPrincipalContext = {
  sub: 'MBR-0001',
  deptId: 'NICHOLS',
  'cognito:groups': 'training-officer',
};

function decidingClient(decision: 'ALLOW' | 'DENY'): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

function buildEvent(traceparent?: string): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/training/certifications/expiring',
    rawPath: '/api/v1/training/certifications/expiring',
    rawQueryString: '',
    headers: { authorization: 'Bearer token', ...(traceparent ? { traceparent } : {}) },
    pathParameters: {},
    requestContext: { authorizer: { lambda: OFFICER } },
  } as unknown as GuardEvent;
}

beforeEach(() => {
  vi.resetModules();
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  process.env.TRAINING_DYNAMO_TABLE_NAME = 'platform-service';
  process.env.PLATFORM_CONFIG_DYNAMO_TABLE_NAME = 'platform-service';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function buildEventWithoutAuthorizer(): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/training/certifications/expiring',
    rawPath: '/api/v1/training/certifications/expiring',
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: {},
    requestContext: {},
  } as unknown as GuardEvent;
}

describe('expiring.ts handler (entrypoint, AC3)', () => {
  it('returns 401 when the authorizer context is missing (unauthenticated boundary)', async () => {
    const { handler } = await import('./expiring.js');

    const result = await handler(buildEventWithoutAuthorizer());

    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 403 when Cedar denies the request', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('DENY'));
    const { handler } = await import('./expiring.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 when Verified Permissions is unavailable (fail-closed)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    const client = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    createAuthzClient(process.env, client);
    const { handler } = await import('./expiring.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('lists certs due within the configured lead-time window, matching what the scanner would flag (AC3)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { createDynamoClient } = await import('../dynamoClient.js');
    // Fixture is computed relative to the real clock (5 days out, well within the
    // 30-day lead time) rather than a hardcoded date, which previously went stale
    // and started failing once the calendar caught up to the hardcoded expiryDate.
    const dueSoon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const expiryDate = dueSoon.toISOString().slice(0, 10);
    const expiryYearMonth = expiryDate.slice(0, 7);
    const send = vi.fn((command: unknown) => {
      if (command instanceof GetCommand) {
        return { Item: { value: { certExpiryLeadDays: 30 } } };
      }
      if (command instanceof QueryCommand) {
        const gsi2pk = command.input.ExpressionAttributeValues?.[':gsi2pk'] as string;
        return {
          Items: gsi2pk.includes(expiryYearMonth)
            ? [
                {
                  certId: 'CERT-1',
                  memberId: 'MBR-1',
                  certType: 'FF1',
                  issueDate: '2024-01-01',
                  expiryDate,
                  issuingAuthority: 'CT DESPP',
                  attachmentS3Key: null,
                  status: 'CURRENT',
                },
              ]
            : [],
        };
      }
      throw new Error('unexpected command');
    });
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const { handler } = await import('./expiring.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { certId: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]?.certId).toBe('CERT-1');
  });

  it('returns 200 with an empty array when no certs are due', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { createDynamoClient } = await import('../dynamoClient.js');
    const send = vi.fn((command: unknown) => {
      if (command instanceof GetCommand) {
        return {};
      }
      return { Items: [] };
    });
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const { handler } = await import('./expiring.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((result as { body: string }).body)).toEqual([]);
  });

  it('returns 503 via serviceUnavailableProblem and logs the original error when the repository query fails', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { createDynamoClient } = await import('../dynamoClient.js');
    const failure = new Error('DynamoDB throttled');
    const send = vi.fn().mockRejectedValue(failure);
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./expiring.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 503 });
    const logged = errorSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === 'certification.expiring.unhandled');
    expect(logged?.reason).toBe('Error');
    errorSpy.mockRestore();
  });
});
