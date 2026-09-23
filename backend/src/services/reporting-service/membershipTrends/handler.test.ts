import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { GuardEvent } from '@boxalarm/authz';

const DEPT_ID = 'NICHOLS';
const PRINCIPAL = { sub: 'mbr-admin', deptId: DEPT_ID, 'cognito:groups': 'admin' };

function buildEvent(
  query: Record<string, string> | undefined,
  options: {
    readonly headers?: Record<string, string> | undefined;
    readonly principal?: Record<string, unknown> | null;
  } = {},
): GuardEvent {
  const principal = options.principal === null ? undefined : (options.principal ?? PRINCIPAL);
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/reporting/membership-trends',
    rawPath: '/api/v1/reporting/membership-trends',
    rawQueryString: '',
    queryStringParameters: query,
    headers: 'headers' in options ? options.headers : { authorization: 'Bearer token' },
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

function mockDynamo(behavior: 'OK' | 'ERROR'): { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  if (behavior === 'OK') {
    send.mockResolvedValue({ Items: [] });
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

function mockDynamoRealistic(fixtures: {
  readonly roster: readonly Record<string, unknown>[];
  readonly auditByMember: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  readonly attendanceByMember: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}): { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn((command: { input: Record<string, unknown> }) => {
    const values = command.input.ExpressionAttributeValues as Record<string, unknown> | undefined;
    if (command.input.IndexName === 'GSI3' && values?.[':gsi3pk'] === `DEPT#${DEPT_ID}#MEMBER`) {
      return { Items: fixtures.roster };
    }
    if (command.input.IndexName === 'GSI3') {
      const memberId = (values?.[':gsi3pk'] as string).split('#').pop() as string;
      return { Items: fixtures.auditByMember[memberId] ?? [] };
    }
    if (command.input.IndexName === 'GSI1') {
      const memberId = (values?.[':gsi1pk'] as string).replace('MEMBER#', '');
      return { Items: fixtures.attendanceByMember[memberId] ?? [] };
    }
    return { Items: [] };
  });
  const client = { send };
  vi.doMock('../dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../dynamoClient.js')>();
    return { ...actual, createDynamoClient: () => client };
  });
  return client;
}

describe('membership-trends handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PERSONNEL_TABLE_NAME = 'personnel-service';
    process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('@aws-sdk/client-verifiedpermissions');
    vi.doUnmock('../dynamoClient.js');
  });

  it('returns 200 with a computed membership trend for a valid admin request (AC1, AC2, entrypoint-test)', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = (await handler(
      buildEvent({ startDate: '2026-01-01', endDate: '2026-03-01' }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string) as { startCount: number; buckets: unknown[] };
    expect(body).toHaveProperty('startCount');
    expect(body).toHaveProperty('endCount');
    expect(body).toHaveProperty('netChange');
    expect(body).toHaveProperty('periodStart');
    expect(body).toHaveProperty('periodEnd');
    expect(Array.isArray(body.buckets)).toBe(true);
  });

  it('returns concrete non-zero counts and a non-zero attendance rate from writer-shaped MEMBER/AUDIT_LOG_ENTRY/ATTENDANCE_RECORD fixtures (P13, core-harm)', async () => {
    mockAuthzDecision('ALLOW');
    const occurredAtSec = Math.floor(Date.UTC(2026, 1, 10) / 1000);
    mockDynamoRealistic({
      roster: [{ memberId: 'mbr-102', status: 'ACTIVE', createdAt: Date.UTC(2025, 11, 1) }],
      auditByMember: {
        'mbr-102': [
          {
            mutatedEntityType: 'MEMBER',
            action: 'CREATE',
            changedFields: { status: { old: null, new: 'PROBATIONARY' } },
            ts: Date.UTC(2025, 11, 1),
          },
          {
            mutatedEntityType: 'MEMBER',
            action: 'UPDATE',
            changedFields: { status: { old: 'PROBATIONARY', new: 'ACTIVE' } },
            ts: Date.UTC(2025, 11, 15),
          },
        ],
      },
      attendanceByMember: {
        'mbr-102': [{ activityType: 'DRILL', occurredAt: occurredAtSec }],
      },
    });
    const { handler } = await import('./handler.js');

    const result = (await handler(
      buildEvent({ startDate: '2026-01-01', endDate: '2026-03-01' }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string) as {
      startCount: number;
      endCount: number;
      buckets: { bucket: string; attendanceRateByActivityType: Record<string, number> }[];
    };
    expect(body.startCount).toBe(1);
    expect(body.endCount).toBe(1);
    const februaryBucket = body.buckets.find((b) => b.bucket === '2026-02');
    expect(februaryBucket?.attendanceRateByActivityType.DRILL).toBe(1);
  });

  it('returns 400 when startDate/endDate are missing', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent(undefined));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when endDate is before startDate', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent({ startDate: '2026-03-01', endDate: '2026-01-01' }));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when the requested range exceeds 731 days (P4)', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent({ startDate: '2020-01-01', endDate: '2026-01-01' }));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('rejects a non-admin caller with 403 (AC4)', async () => {
    mockAuthzDecision('DENY');
    const client = mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent({ startDate: '2026-01-01', endDate: '2026-03-01' }));

    expect(result).toMatchObject({ statusCode: 403 });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('denies (fails closed) when no Authorization header is present', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = await handler(
      buildEvent({ startDate: '2026-01-01', endDate: '2026-03-01' }, { headers: undefined }),
    );

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 (fail-secure, never a defaulted allow) when Verified Permissions is unavailable (core-harm)', async () => {
    mockAuthzDecision('ERROR');
    const client = mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent({ startDate: '2026-01-01', endDate: '2026-03-01' }));

    expect(result).toMatchObject({ statusCode: 503 });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('returns 503 when the personnel or platform table is unavailable', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('ERROR');
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent({ startDate: '2026-01-01', endDate: '2026-03-01' }));

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('logs the original error before returning a problem response on a DynamoDB failure (error-path-logging)', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('ERROR');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./handler.js');

    await handler(buildEvent({ startDate: '2026-01-01', endDate: '2026-03-01' }));

    expect(errorSpy).toHaveBeenCalled();
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as {
      originalError?: string;
    };
    expect(logged.originalError).toBeTruthy();
    errorSpy.mockRestore();
  });

  it('emits a MembershipTrends business metric on success and on failure (business-metrics)', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./handler.js');

    await handler(buildEvent({ startDate: '2026-01-01', endDate: '2026-03-01' }));

    expect(
      logSpy.mock.calls.some((call) => (call[0] as string).includes('MembershipTrendsQueried')),
    ).toBe(true);
    logSpy.mockRestore();
  });

  it('logs at request start and on successful completion (observability, unreachable-on-timeout gap)', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./handler.js');

    await handler(buildEvent({ startDate: '2026-01-01', endDate: '2026-03-01' }));

    const events = logSpy.mock.calls.map(
      (call) => (JSON.parse(call[0] as string) as { event: string }).event,
    );
    expect(events).toContain('reporting.membership_trends.query_started');
    expect(events).toContain('reporting.membership_trends.query_completed');
    logSpy.mockRestore();
  });
});

describe('parseDateRange', () => {
  it('parses a valid ISO startDate/endDate pair, normalizing endDate to end-of-day', async () => {
    const { parseDateRange } = await import('./handler.js');
    const range = parseDateRange({ startDate: '2026-01-01', endDate: '2026-03-01' });
    expect(range).toEqual({
      startMs: Date.parse('2026-01-01'),
      endMs: Date.parse('2026-03-01') + 86_400_000 - 1,
    });
  });

  it('includes participation recorded on the final requested day (P12)', async () => {
    const { parseDateRange } = await import('./handler.js');
    const range = parseDateRange({ startDate: '2026-03-01', endDate: '2026-03-31' });
    const lateOnFinalDay = Date.UTC(2026, 2, 31, 23, 59, 0);
    expect(range).toBeDefined();
    expect(lateOnFinalDay).toBeLessThanOrEqual(range?.endMs as number);
  });

  it('returns undefined when startDate or endDate is missing', async () => {
    const { parseDateRange } = await import('./handler.js');
    expect(parseDateRange({ startDate: '2026-01-01' })).toBeUndefined();
    expect(parseDateRange({ endDate: '2026-01-01' })).toBeUndefined();
    expect(parseDateRange(undefined)).toBeUndefined();
    expect(parseDateRange(null)).toBeUndefined();
  });

  it('returns undefined on an empty string', async () => {
    const { parseDateRange } = await import('./handler.js');
    expect(parseDateRange({ startDate: '', endDate: '2026-01-01' })).toBeUndefined();
  });

  it('returns undefined on a non-ISO wrong-typed date string', async () => {
    const { parseDateRange } = await import('./handler.js');
    expect(parseDateRange({ startDate: 'abc', endDate: '2026-01-01' })).toBeUndefined();
  });

  it('returns undefined when endDate is before startDate', async () => {
    const { parseDateRange } = await import('./handler.js');
    expect(parseDateRange({ startDate: '2026-03-01', endDate: '2026-01-01' })).toBeUndefined();
  });

  it('allows a future date range', async () => {
    const { parseDateRange } = await import('./handler.js');
    const range = parseDateRange({ startDate: '2099-01-01', endDate: '2099-02-01' });
    expect(range).toBeDefined();
  });

  it('rejects a range spanning more than 731 days (P4)', async () => {
    const { parseDateRange } = await import('./handler.js');
    expect(parseDateRange({ startDate: '2020-01-01', endDate: '2026-01-01' })).toBeUndefined();
  });

  it('accepts a range comfortably within the 731-day cap', async () => {
    const { parseDateRange } = await import('./handler.js');
    expect(parseDateRange({ startDate: '2025-01-01', endDate: '2026-01-01' })).toBeDefined();
  });
});
