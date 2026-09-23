import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const originalEnv = { ...process.env };

const MEMBER: CedarPrincipalContext = {
  sub: 'MBR-0034',
  deptId: 'NICHOLS',
  'cognito:groups': 'member',
};

function decidingClient(decision: 'ALLOW' | 'DENY'): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

function buildEvent(memberId: string): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/training/members/{memberId}/transcript',
    rawPath: `/api/v1/training/members/${memberId}/transcript`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: { memberId },
    requestContext: { authorizer: { lambda: MEMBER } },
  } as unknown as GuardEvent;
}

beforeEach(() => {
  vi.resetModules();
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  process.env.TRAINING_DYNAMO_TABLE_NAME = 'training-certs';
  process.env.TRAINING_TABLE_NAME = 'training-events';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('transcript/get.ts authorization (AC4)', () => {
  it("returns 403 when Cedar denies a non-owning, non-officer member requesting another member's transcript", async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('DENY'));
    const { handler } = await import('./get.js');

    const result = await handler(buildEvent('MBR-9999'));

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 200 when Cedar allows the member requesting their own transcript', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { createDynamoClient } = await import('../dynamoClient.js');
    createDynamoClient({ send: vi.fn().mockResolvedValue({}) } as never);
    const { handler } = await import('./get.js');

    const result = await handler(buildEvent('MBR-0034'));

    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('returns 503, fail-closed, when Verified Permissions is unreachable rather than defaulting to allow', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    const client = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    createAuthzClient(process.env, client);
    const { handler } = await import('./get.js');

    const result = await handler(buildEvent('MBR-0034'));

    expect(result).toMatchObject({ statusCode: 503 });
  });
});
