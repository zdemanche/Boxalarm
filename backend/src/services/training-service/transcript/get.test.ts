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

function allowClient(): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision.ALLOW }),
  } as unknown as VerifiedPermissionsClient;
}

function buildEvent(options: { memberId?: string; format?: string } = {}): GuardEvent {
  const memberId = options.memberId ?? 'MBR-0034';
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/training/members/{memberId}/transcript',
    rawPath: `/api/v1/training/members/${memberId}/transcript`,
    rawQueryString: options.format ? `format=${options.format}` : '',
    headers: { authorization: 'Bearer token' },
    pathParameters: { memberId },
    queryStringParameters: options.format ? { format: options.format } : undefined,
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

describe('transcript/get.ts handler (entrypoint)', () => {
  it('returns 400 when memberId path param is absent', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, allowClient());
    const { handler } = await import('./get.js');

    const event = buildEvent();
    (event as unknown as { pathParameters: unknown }).pathParameters = {};

    const result = await handler(event);

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when format is not json, csv, or pdf', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, allowClient());
    const { handler } = await import('./get.js');

    const result = await handler(buildEvent({ format: 'xls' }));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 200 with an empty-but-well-formed transcript for a member with no history (AC3)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, allowClient());
    const { createDynamoClient } = await import('../dynamoClient.js');
    const send = vi.fn().mockResolvedValue({});
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const { handler } = await import('./get.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      memberId: string;
      certifications: unknown[];
      attendance: unknown[];
      hoursByCategory: Record<string, number>;
    };
    expect(body).toEqual({
      memberId: 'MBR-0034',
      certifications: [],
      attendance: [],
      hoursByCategory: {},
    });
  });

  it('returns 200 with certifications, attendance, and category-hour totals in one payload (AC1)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, allowClient());
    const { createDynamoClient } = await import('../dynamoClient.js');
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          {
            certId: 'CERT-0001',
            memberId: 'MBR-0034',
            certType: 'FF1',
            issueDate: '2020-01-10',
            expiryDate: '2099-01-10',
            issuingAuthority: 'CT DESPP',
            attachmentS3Key: null,
            status: 'CURRENT',
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          { eventId: 'e1', category: 'LADDER_OPS', hours: 3, gsi1sk: 'TRAINING_ATTENDANCE#100' },
        ],
      });
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const { handler } = await import('./get.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      certifications: { certId: string }[];
      attendance: { eventId: string }[];
      hoursByCategory: Record<string, number>;
    };
    expect(body.certifications[0]?.certId).toBe('CERT-0001');
    expect(body.attendance[0]?.eventId).toBe('e1');
    expect(body.hoursByCategory).toEqual({ LADDER_OPS: 3 });
  });

  it('returns 200 text/csv with transcript content for format=csv (AC2)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, allowClient());
    const { createDynamoClient } = await import('../dynamoClient.js');
    const send = vi.fn().mockResolvedValue({});
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const { handler } = await import('./get.js');

    const result = await handler(buildEvent({ format: 'csv' }));

    expect(result).toMatchObject({
      statusCode: 200,
      headers: { 'content-type': 'text/csv' },
    });
    expect((result as { body: string }).body).toContain('Certifications');
  });

  it('returns 200 application/pdf, base64-encoded, for format=pdf (AC2)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, allowClient());
    const { createDynamoClient } = await import('../dynamoClient.js');
    const send = vi.fn().mockResolvedValue({});
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const { handler } = await import('./get.js');

    const result = await handler(buildEvent({ format: 'pdf' }));

    expect(result).toMatchObject({
      statusCode: 200,
      headers: { 'content-type': 'application/pdf' },
      isBase64Encoded: true,
    });
  });

  it('returns a 500 RFC 7807 problem with traceId when the repository query fails unexpectedly, logging the original error', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, allowClient());
    const { createDynamoClient } = await import('../dynamoClient.js');
    const send = vi.fn().mockRejectedValue(new Error('DynamoDB throttled'));
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./get.js');

    const event = buildEvent();
    (event as unknown as { headers: Record<string, string> }).headers.traceparent =
      '00-tracefail2000000000000000000-01234567890abcde-01';

    const result = await handler(event);

    expect(result).toMatchObject({ statusCode: 500 });
    const body = JSON.parse((result as { body: string }).body) as {
      status: number;
      traceId: string;
    };
    expect(body.status).toBe(500);
    expect(body.traceId).toBe('tracefail2000000000000000000');
    expect(errorSpy).toHaveBeenCalled();
    const loggedPayload = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(loggedPayload).toContain('DynamoDB throttled');
    errorSpy.mockRestore();
  });
});
