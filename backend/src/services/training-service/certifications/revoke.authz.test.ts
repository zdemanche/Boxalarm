import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const originalEnv = { ...process.env };

const OFFICER: CedarPrincipalContext = {
  sub: 'MBR-0001',
  deptId: 'NICHOLS',
  'cognito:groups': 'officer',
};

function buildEvent(): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/training/members/{memberId}/certifications/{certId}/revoke',
    rawPath: '/api/v1/training/members/MBR-0034/certifications/CERT-0091/revoke',
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: { memberId: 'MBR-0034', certId: 'CERT-0091' },
    body: undefined,
    requestContext: { authorizer: { lambda: OFFICER } },
  } as unknown as GuardEvent;
}

beforeEach(() => {
  vi.resetModules();
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  process.env.TRAINING_DYNAMO_TABLE_NAME = 'platform-service';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('revoke.ts handler (auth-patterns fail-secure)', () => {
  it('returns 403 on a Cedar deny before any repository write', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    const client = {
      send: vi.fn().mockResolvedValue({ decision: Decision.DENY }),
    } as unknown as VerifiedPermissionsClient;
    createAuthzClient(process.env, client);
    const { handler } = await import('./revoke.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 403 when the bearer token is missing', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    const send = vi.fn().mockResolvedValue({ decision: Decision.ALLOW });
    const client = { send } as unknown as VerifiedPermissionsClient;
    createAuthzClient(process.env, client);
    const { handler } = await import('./revoke.js');
    const event = buildEvent();
    (event.headers as Record<string, string>).authorization = '';

    const result = await handler(event);

    expect(result).toMatchObject({ statusCode: 403 });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 503 when Verified Permissions is unavailable', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    const client = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    createAuthzClient(process.env, client);
    const { handler } = await import('./revoke.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 503 });
  });
});
