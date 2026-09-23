import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const loggedErrors = vi.fn();
vi.mock('../logger.js', () => ({ logError: loggedErrors, logInfo: vi.fn() }));

const originalEnv = { ...process.env };

const OFFICER: CedarPrincipalContext = {
  sub: 'MBR-0001',
  deptId: 'NICHOLS',
  'cognito:groups': 'officer',
};

function decidingClient(decision: 'ALLOW' | 'DENY'): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

function buildEvent(memberId = 'MBR-0034', certId = 'CERT-0091'): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/training/members/{memberId}/certifications/{certId}/revoke',
    rawPath: `/api/v1/training/members/${memberId}/certifications/${certId}/revoke`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: { memberId, certId },
    body: undefined,
    requestContext: { authorizer: { lambda: OFFICER } },
  } as unknown as GuardEvent;
}

function buildEventWithoutCertId(memberId = 'MBR-0034'): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/training/members/{memberId}/certifications/{certId}/revoke',
    rawPath: `/api/v1/training/members/${memberId}/certifications//revoke`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: { memberId },
    body: undefined,
    requestContext: { authorizer: { lambda: OFFICER } },
  } as unknown as GuardEvent;
}

beforeEach(() => {
  vi.resetModules();
  loggedErrors.mockClear();
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  process.env.TRAINING_DYNAMO_TABLE_NAME = 'platform-service';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('revoke.ts handler (entrypoint)', () => {
  it('returns 400 when certId path parameter is absent', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { handler } = await import('./revoke.js');

    const result = await handler(buildEventWithoutCertId());

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 404 when the certification does not exist', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { createDynamoClient } = await import('../dynamoClient.js');
    const send = vi.fn().mockResolvedValue({});
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const { handler } = await import('./revoke.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('revokes an existing CURRENT cert and returns 200 with status REVOKED (AC5)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { createDynamoClient } = await import('../dynamoClient.js');
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Item: {
          certId: 'CERT-0091',
          memberId: 'MBR-0034',
          certType: 'FF1',
          issueDate: '2024-01-10',
          expiryDate: '2027-01-10',
          issuingAuthority: 'CT DESPP',
          attachmentS3Key: null,
          status: 'CURRENT',
        },
      })
      .mockResolvedValueOnce({});
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const { handler } = await import('./revoke.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 200 });
    const record = JSON.parse((result as { body: string }).body) as { status: string };
    expect(record.status).toBe('REVOKED');
  });

  it('returns a 500 RFC 7807 problem and logs the original error on an unexpected repository failure', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { createDynamoClient } = await import('../dynamoClient.js');
    const send = vi.fn().mockRejectedValue(new Error('DynamoDB throttled'));
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const { handler } = await import('./revoke.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 500 });
    expect(loggedErrors).toHaveBeenCalled();
  });
});
