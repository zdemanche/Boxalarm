import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const originalEnv = { ...process.env };

const CHIEF: CedarPrincipalContext = {
  sub: 'MBR-0001',
  deptId: 'NICHOLS',
  'cognito:groups': 'admin',
};

function decidingClient(decision: 'ALLOW' | 'DENY'): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

function buildEvent(period: string | undefined, traceparent?: string): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/training/reports/iso',
    rawPath: '/api/v1/training/reports/iso',
    rawQueryString: period ? `period=${period}` : '',
    headers: { authorization: 'Bearer token', ...(traceparent ? { traceparent } : {}) },
    queryStringParameters: period ? { period } : undefined,
    requestContext: { authorizer: { lambda: CHIEF } },
  } as unknown as GuardEvent;
}

function gsi3Item(eventId: string, startAt: number): Record<string, unknown> {
  return { eventId, startAt };
}

beforeEach(() => {
  vi.resetModules();
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  process.env.TRAINING_TABLE_NAME = 'platform-table';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('iso.ts handler (entrypoint)', () => {
  it('returns 403 when Cedar denies (AC1 access boundary)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('DENY'));
    const { handler } = await import('./iso.js');

    const result = await handler(buildEvent('2026'));

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 when Verified Permissions is unavailable', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    const client = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    createAuthzClient(process.env, client);
    const { handler } = await import('./iso.js');

    const result = await handler(buildEvent('2026'));

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 400 when period is missing or not a positive integer year', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { handler } = await import('./iso.js');

    expect(await handler(buildEvent(undefined))).toMatchObject({ statusCode: 400 });
    expect(await handler(buildEvent('abc'))).toMatchObject({ statusCode: 400 });
    expect(await handler(buildEvent('2026.5'))).toMatchObject({ statusCode: 400 });
    expect(await handler(buildEvent('-1'))).toMatchObject({ statusCode: 400 });
  });

  it('returns 200 with a zero-totals report when no records exist for the period, not an error (AC3)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { createDocumentClient } = await import('../client.js');
    createDocumentClient(process.env, {
      send: vi.fn().mockResolvedValue({}),
    } as unknown as DynamoDBDocumentClient);
    const { handler } = await import('./iso.js');

    const result = await handler(buildEvent('9999'));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      period: number;
      departmentTotalHours: number;
      categories: unknown[];
    };
    expect(body).toEqual({ period: 9999, departmentTotalHours: 0, categories: [] });
  });

  it('rolls up TRAINING_ATTENDANCE into per-category, per-member, and department totals that reconcile against the source rows (AC1, AC2)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { createDocumentClient } = await import('../client.js');
    const send = vi.fn((command: unknown) => {
      const c = command as {
        input: { IndexName?: string; ExpressionAttributeValues?: Record<string, unknown> };
      };
      if (c.input.IndexName === 'GSI3') {
        return Promise.resolve({ Items: [gsi3Item('e1', Date.UTC(2026, 5, 1))] });
      }
      return Promise.resolve({
        Items: [
          { eventId: 'e1', memberId: 'MBR-1', category: 'ems', hours: 3 },
          { eventId: 'e1', memberId: 'MBR-2', category: 'ems', hours: 2 },
        ],
      });
    });
    createDocumentClient(process.env, { send } as unknown as DynamoDBDocumentClient);
    const { handler } = await import('./iso.js');

    const result = await handler(buildEvent('2026'));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      departmentTotalHours: number;
      categories: { category: string; totalHours: number }[];
    };
    expect(body.departmentTotalHours).toBe(5);
    expect(body.categories).toEqual([
      {
        category: 'EMS',
        totalHours: 5,
        members: [
          { memberId: 'MBR-1', hours: 3 },
          { memberId: 'MBR-2', hours: 2 },
        ],
      },
    ]);
  });

  it('returns 503 (fail-closed, not partial data) when the DynamoDB Query fails', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { createDocumentClient } = await import('../client.js');
    createDocumentClient(process.env, {
      send: vi.fn().mockRejectedValue(new Error('DynamoDB unavailable')),
    } as unknown as DynamoDBDocumentClient);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./iso.js');

    const result = await handler(
      buildEvent('2026', '00-tracefail2000000000000000000-01234567890abcde-01'),
    );

    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
