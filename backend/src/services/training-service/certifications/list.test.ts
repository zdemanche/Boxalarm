import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
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

function buildEvent(memberId = 'MBR-0034', traceparent?: string): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/training/members/{memberId}/certifications',
    rawPath: `/api/v1/training/members/${memberId}/certifications`,
    rawQueryString: '',
    headers: {
      authorization: 'Bearer token',
      ...(traceparent ? { traceparent } : {}),
    },
    pathParameters: { memberId },
    requestContext: { authorizer: { lambda: MEMBER } },
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

describe('list.ts handler (entrypoint)', () => {
  it("returns 403 when Cedar denies a member requesting another member's certifications (AC3)", async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('DENY'));
    const { handler } = await import('./list.js');

    const result = await handler(buildEvent('MBR-9999'));

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 when Verified Permissions is unavailable', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    const client = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    createAuthzClient(process.env, client);
    const { handler } = await import('./list.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 200 with an empty array when the member has zero certifications', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { createDynamoClient } = await import('../dynamoClient.js');
    const send = vi.fn().mockResolvedValue({});
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const { handler } = await import('./list.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as unknown[];
    expect(body).toEqual([]);
  });

  it("returns 200 with the member's own CURRENT/EXPIRED/REVOKED certifications, status derived at read time (AC1, AC3)", async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { createDynamoClient } = await import('../dynamoClient.js');
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          certId: 'CERT-0001',
          memberId: 'MBR-0034',
          certType: 'FF1',
          issueDate: '2020-01-10',
          expiryDate: '2021-01-10',
          issuingAuthority: 'CT DESPP',
          attachmentS3Key: null,
          status: 'CURRENT',
        },
        {
          certId: 'CERT-0002',
          memberId: 'MBR-0034',
          certType: 'HAZMAT',
          issueDate: '2020-01-10',
          expiryDate: '2099-01-10',
          issuingAuthority: 'CT DESPP',
          attachmentS3Key: null,
          status: 'REVOKED',
        },
      ],
    });
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const { handler } = await import('./list.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      certId: string;
      status: string;
    }[];
    expect(body.find((c) => c.certId === 'CERT-0001')?.status).toBe('EXPIRED');
    expect(body.find((c) => c.certId === 'CERT-0002')?.status).toBe('REVOKED');
  });

  it('returns a 500 RFC 7807 problem with traceId when the repository query fails unexpectedly', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { createDynamoClient } = await import('../dynamoClient.js');
    const send = vi.fn().mockRejectedValue(new Error('DynamoDB throttled'));
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./list.js');

    const result = await handler(
      buildEvent('MBR-0034', '00-tracefail2000000000000000000-01234567890abcde-01'),
    );

    expect(result).toMatchObject({ statusCode: 500 });
    const body = JSON.parse((result as { body: string }).body) as {
      status: number;
      traceId: string;
    };
    expect(body.status).toBe(500);
    expect(body.traceId).toBe('tracefail2000000000000000000');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('returns a 500 RFC 7807 problem when DynamoDB client construction throws (fail-closed, no unhandled escape)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    vi.doMock('aws-xray-sdk-core', () => ({
      default: {
        captureAWSv3Client: vi.fn(() => {
          throw new Error('xray init failed');
        }),
      },
    }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./list.js');

    const result = await handler(
      buildEvent('MBR-0034', '00-traceclient00000000000000000-01234567890abcde-01'),
    );

    expect(result).toMatchObject({ statusCode: 500 });
    const body = JSON.parse((result as { body: string }).body) as {
      status: number;
      traceId: string;
    };
    expect(body.status).toBe(500);
    expect(body.traceId).toBe('traceclient00000000000000000');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    vi.doUnmock('aws-xray-sdk-core');
  });
});
