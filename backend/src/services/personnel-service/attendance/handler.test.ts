import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { GuardEvent } from '@boxalarm/authz';

const DEPT_ID = 'NICHOLS';
const MEMBER_ID = 'mbr-102';
const PRINCIPAL = { sub: MEMBER_ID, deptId: DEPT_ID, 'cognito:groups': 'member' };

function buildEvent(
  body: unknown,
  options: {
    readonly headers?: Record<string, string> | undefined;
    readonly principal?: Record<string, unknown> | null;
  } = {},
): GuardEvent {
  const principal = options.principal === null ? undefined : (options.principal ?? PRINCIPAL);
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/personnel/attendance',
    rawPath: '/api/v1/personnel/attendance',
    rawQueryString: '',
    headers: 'headers' in options ? options.headers : { authorization: 'Bearer token' },
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: { authorizer: { lambda: principal } },
  } as unknown as GuardEvent;
}

function mockAuthzDecision(decision: 'ALLOW' | 'DENY' | 'ERROR'): void {
  vi.doMock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
    return {
      ...actual,
      VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({
        send:
          decision === 'ERROR'
            ? vi.fn().mockRejectedValue(new Error('VP outage'))
            : vi.fn().mockResolvedValue({ decision: actual.Decision[decision] }),
      })),
    };
  });
}

function mockDynamo(behavior: 'OK' | 'CONFLICT' | 'ERROR'): { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  if (behavior === 'OK') {
    send.mockResolvedValue({});
  } else if (behavior === 'CONFLICT') {
    send.mockImplementation(async () => {
      const { ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
      throw new ConditionalCheckFailedException({ message: 'conflict', $metadata: {} });
    });
  } else {
    send.mockRejectedValue(new Error('DynamoDB unavailable'));
  }
  const client = { send };
  vi.doMock('../dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../dynamoClient.js')>();
    return { ...actual, createDynamoClient: () => client };
  });
  return client;
}

describe('handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('@aws-sdk/client-verifiedpermissions');
    vi.doUnmock('../dynamoClient.js');
  });

  it.each(['CALL', 'DRILL', 'MEETING', 'WORK_DETAIL', 'STANDBY'] as const)(
    'creates an ATTENDANCE_RECORD under the member partition for activityType %s (AC1)',
    async (activityType) => {
      mockAuthzDecision('ALLOW');
      const client = mockDynamo('OK');
      const { handler } = await import('./handler.js');

      const result = (await handler(
        buildEvent({
          activityType,
          refId: activityType === 'CALL' ? 'dispatch-4471' : null,
          occurredAt: 1798000500,
          hours: 2.5,
        }),
      )) as APIGatewayProxyStructuredResultV2;

      expect(result.statusCode).toBe(201);
      const putCall = client.send.mock.calls[0]?.[0] as {
        input: { Item: Record<string, unknown> };
      };
      expect(putCall.input.Item.pk).toBe('DEPT#NICHOLS#MEMBER#mbr-102');
      expect(putCall.input.Item.sk).toBe('ATTENDANCE#1798000500');
      expect(putCall.input.Item.entityType).toBe('ATTENDANCE_RECORD');
      expect(putCall.input.Item.activityType).toBe(activityType);
    },
  );

  it('links a CALL attendance record back to its originating dispatch via refId (AC2)', async () => {
    mockAuthzDecision('ALLOW');
    const client = mockDynamo('OK');
    const { handler } = await import('./handler.js');

    await handler(
      buildEvent({
        activityType: 'CALL',
        refId: 'dispatch-4471',
        occurredAt: 1798000500,
        hours: 2,
      }),
    );

    const putCall = client.send.mock.calls[0]?.[0] as { input: { Item: Record<string, unknown> } };
    expect(putCall.input.Item.refId).toBe('dispatch-4471');
  });

  it('constructs GSI1 as MEMBER#{memberId} / ATTENDANCE_RECORD#{occurredAt} (AC3, ticket test note)', async () => {
    mockAuthzDecision('ALLOW');
    const client = mockDynamo('OK');
    const { handler } = await import('./handler.js');

    await handler(
      buildEvent({ activityType: 'DRILL', refId: null, occurredAt: 1798000500, hours: 1 }),
    );

    const putCall = client.send.mock.calls[0]?.[0] as { input: { Item: Record<string, unknown> } };
    expect(putCall.input.Item.gsi1pk).toBe('MEMBER#mbr-102');
    expect(putCall.input.Item.gsi1sk).toBe('ATTENDANCE_RECORD#1798000500');
  });

  it('denies (fails closed) when Cedar denies the action', async () => {
    mockAuthzDecision('DENY');
    const client = mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = await handler(
      buildEvent({ activityType: 'DRILL', refId: null, occurredAt: 1, hours: 1 }),
    );

    expect(result).toMatchObject({ statusCode: 403 });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('denies (fails closed) when no Authorization header is present', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = await handler(
      buildEvent({ activityType: 'DRILL', occurredAt: 1, hours: 1 }, { headers: undefined }),
    );

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('denies (fails closed) with 503, never a defaulted allow, when Verified Permissions is unavailable (core-harm)', async () => {
    mockAuthzDecision('ERROR');
    const client = mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent({ activityType: 'DRILL', occurredAt: 1, hours: 1 }));

    expect(result).toMatchObject({ statusCode: 503 });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('returns 400 on an empty/null body', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent(undefined));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 on an invalid activityType', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent({ activityType: 'BBQ', occurredAt: 1, hours: 1 }));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 on a wrong-typed/negative hours field', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const wrongType = await handler(
      buildEvent({ activityType: 'DRILL', occurredAt: 1, hours: '2' }),
    );
    const negative = await handler(buildEvent({ activityType: 'DRILL', occurredAt: 1, hours: -1 }));

    expect(wrongType).toMatchObject({ statusCode: 400 });
    expect(negative).toMatchObject({ statusCode: 400 });
  });

  it('returns 503 (fail-closed, no partial state) when the DynamoDB write fails', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('ERROR');
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent({ activityType: 'DRILL', occurredAt: 1, hours: 1 }));

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 409 on a duplicate submit (same pk/sk), original record unchanged', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('CONFLICT');
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent({ activityType: 'DRILL', occurredAt: 1, hours: 1 }));

    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('logs the original error before returning a problem response on a DynamoDB failure (error-path-logging)', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('ERROR');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./handler.js');

    await handler(buildEvent({ activityType: 'DRILL', occurredAt: 1, hours: 1 }));

    expect(errorSpy).toHaveBeenCalled();
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as {
      originalError?: string;
      reason?: string;
    };
    expect(logged.originalError).toBeTruthy();
    expect(logged.reason).toBeTruthy();
    errorSpy.mockRestore();
  });

  it('emits an Attendance business metric on success and on failure (business-metrics)', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./handler.js');

    await handler(buildEvent({ activityType: 'DRILL', occurredAt: 1, hours: 1 }));

    expect(
      logSpy.mock.calls.some((call) => (call[0] as string).includes('AttendanceRecorded')),
    ).toBe(true);
    logSpy.mockRestore();
  });
});

describe('buildAttendanceKeys', () => {
  it('builds pk/sk/gsi1pk/gsi1sk per the architecture ATTENDANCE_RECORD entity shape', async () => {
    const { buildAttendanceKeys } = await import('./handler.js');
    const keys = buildAttendanceKeys('NICHOLS' as never, 'mbr-102', 1798000500);
    expect(keys).toEqual({
      pk: 'DEPT#NICHOLS#MEMBER#mbr-102',
      sk: 'ATTENDANCE#1798000500',
      gsi1pk: 'MEMBER#mbr-102',
      gsi1sk: 'ATTENDANCE_RECORD#1798000500',
    });
  });
});
