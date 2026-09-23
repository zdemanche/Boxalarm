import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent } from '@boxalarm/authz';

const PRINCIPAL = { sub: 'member-1', deptId: 'dept-001', 'cognito:groups': 'member' };

function buildEvent(options: {
  principal?: Record<string, string>;
  query?: Record<string, string>;
}): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/training/hours',
    rawPath: '/api/v1/training/hours',
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    queryStringParameters: options.query,
    requestContext: { authorizer: { lambda: options.principal } },
  } as unknown as GuardEvent;
}

function fakeDocumentClient(sendImpl: (command: unknown) => unknown): DynamoDBDocumentClient {
  return { send: vi.fn(sendImpl) } as unknown as DynamoDBDocumentClient;
}

async function seedClients(
  documentClient: DynamoDBDocumentClient,
  vpClient?: VerifiedPermissionsClient,
) {
  const { createDocumentClient } = await import('./client.js');
  createDocumentClient(process.env, documentClient);
  if (vpClient) {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, vpClient);
  }
}

function allowVp(): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision.ALLOW }),
  } as unknown as VerifiedPermissionsClient;
}

function denyVp(): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision.DENY }),
  } as unknown as VerifiedPermissionsClient;
}

describe('hoursHandler (GET /api/v1/training/hours)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.TRAINING_TABLE_NAME = 'platform-table';
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 403 when the bearer token / principal is missing or invalid', async () => {
    const { handler } = await import('./hoursHandler.js');
    const result = await handler(buildEvent({ query: { from: '0', to: '10' } }));
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 400 when from/to are absent', async () => {
    const { handler } = await import('./hoursHandler.js');
    const result = await handler(buildEvent({ principal: PRINCIPAL, query: {} }));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when from/to are non-numeric or from > to', async () => {
    const { handler } = await import('./hoursHandler.js');
    const nonNumeric = await handler(
      buildEvent({ principal: PRINCIPAL, query: { from: 'x', to: '10' } }),
    );
    expect(nonNumeric).toMatchObject({ statusCode: 400 });

    const reversed = await handler(
      buildEvent({ principal: PRINCIPAL, query: { from: '10', to: '0' } }),
    );
    expect(reversed).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when memberId is present but empty', async () => {
    const { handler } = await import('./hoursHandler.js');
    const result = await handler(
      buildEvent({ principal: PRINCIPAL, query: { memberId: '', from: '0', to: '10' } }),
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it("returns 403 on a Cedar deny, member querying another member's hours", async () => {
    await seedClients(
      fakeDocumentClient(() => ({})),
      denyVp(),
    );
    const { handler } = await import('./hoursHandler.js');
    const result = await handler(
      buildEvent({ principal: PRINCIPAL, query: { memberId: 'member-9', from: '0', to: '10' } }),
    );
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 403 on a Cedar deny, non-officer querying roster-wide (memberId absent)', async () => {
    await seedClients(
      fakeDocumentClient(() => ({})),
      denyVp(),
    );
    const { handler } = await import('./hoursHandler.js');
    const result = await handler(
      buildEvent({ principal: PRINCIPAL, query: { from: '0', to: '10' } }),
    );
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 (fail-closed) when Verified Permissions is unavailable', async () => {
    const vpClient = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    await seedClients(
      fakeDocumentClient(() => ({})),
      vpClient,
    );
    const { handler } = await import('./hoursHandler.js');
    const result = await handler(
      buildEvent({ principal: PRINCIPAL, query: { from: '0', to: '10' } }),
    );
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 503 (fail-closed) when the DynamoDB Query throws', async () => {
    await seedClients(
      fakeDocumentClient(() => {
        throw new Error('DynamoDB unavailable');
      }),
      allowVp(),
    );
    const { handler } = await import('./hoursHandler.js');
    const result = await handler(
      buildEvent({ principal: PRINCIPAL, query: { memberId: 'member-1', from: '0', to: '10' } }),
    );
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it("returns 200 with hours broken out by category for a member's own view, including a zero-hours category (AC1, entrypoint-test)", async () => {
    await seedClients(
      fakeDocumentClient((command) => {
        const c = command as { constructor: { name: string } };
        if (c.constructor.name === 'QueryCommand') {
          return {
            Items: [
              {
                pk: 'DEPT#dept-001#TRAINING_EVENT#e1',
                memberId: 'member-1',
                category: 'fireground',
                hours: 2,
                gsi1sk: 'TRAINING_ATTENDANCE#5',
              },
              {
                pk: 'DEPT#dept-001#TRAINING_EVENT#e2',
                memberId: 'member-1',
                category: 'ems',
                hours: 0,
                gsi1sk: 'TRAINING_ATTENDANCE#6',
              },
            ],
          };
        }
        return {};
      }),
      allowVp(),
    );
    const { handler } = await import('./hoursHandler.js');
    const result = await handler(
      buildEvent({ principal: PRINCIPAL, query: { memberId: 'member-1', from: '0', to: '10' } }),
    );
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      categories: Array<{ category: string; hours: number }>;
    };
    expect(body.categories).toEqual(
      expect.arrayContaining([
        { category: 'fireground', hours: 2 },
        { category: 'ems', hours: 0 },
      ]),
    );
  });

  it('returns 200 with roster-wide per-member totals aggregated app-side, no caller-supplied per-member loop (AC2)', async () => {
    await seedClients(
      fakeDocumentClient((command) => {
        const c = command as {
          constructor: { name: string };
          input: Record<string, unknown>;
        };
        if (c.constructor.name === 'QueryCommand' && c.input.IndexName === 'GSI3') {
          return {
            Items: [
              { eventId: 'e1', title: 'Drill', category: 'fireground', startAt: 5, endAt: 6 },
            ],
          };
        }
        if (c.constructor.name === 'QueryCommand') {
          return { Items: [{ memberId: 'member-1', category: 'fireground', hours: 2 }] };
        }
        return {};
      }),
      allowVp(),
    );
    const { handler } = await import('./hoursHandler.js');
    const result = await handler(
      buildEvent({ principal: PRINCIPAL, query: { from: '0', to: '10' } }),
    );
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      members: Array<{ memberId: string; categories: Array<{ category: string; hours: number }> }>;
    };
    expect(body.members).toEqual([
      { memberId: 'member-1', categories: [{ category: 'fireground', hours: 2 }] },
    ]);
  });

  it('member self-view (GSI1 branch) and officer roster-wide aggregate view (GSI3 + base-table branch) report identical totals for the same member/range (AC3, no discrepancy)', async () => {
    const IN_RANGE_EVENT = {
      eventId: 'e1',
      title: 'Drill',
      category: 'fireground',
      startAt: 5,
      endAt: 6,
    };

    const documentClient = fakeDocumentClient((command) => {
      const c = command as { constructor: { name: string }; input: Record<string, unknown> };
      if (c.constructor.name === 'QueryCommand' && c.input.IndexName === 'GSI3') {
        return { Items: [IN_RANGE_EVENT] };
      }
      if (c.constructor.name === 'QueryCommand' && c.input.IndexName === 'GSI1') {
        return {
          Items: [
            {
              pk: 'DEPT#dept-001#TRAINING_EVENT#e1',
              memberId: 'member-1',
              category: 'fireground',
              hours: 4,
              gsi1sk: 'TRAINING_ATTENDANCE#5',
            },
            {
              pk: 'DEPT#dept-001#TRAINING_EVENT#e9',
              memberId: 'member-1',
              category: 'ems',
              hours: 99,
              gsi1sk: 'TRAINING_ATTENDANCE#9000',
            },
          ],
        };
      }
      const values = c.input.ExpressionAttributeValues as Record<string, string> | undefined;
      if (
        c.constructor.name === 'QueryCommand' &&
        values?.[':pk'] === 'DEPT#dept-001#TRAINING_EVENT#e1'
      ) {
        return {
          Items: [
            { memberId: 'member-1', category: 'fireground', hours: 4 },
            { memberId: 'member-2', category: 'fireground', hours: 1 },
          ],
        };
      }
      return {};
    });
    await seedClients(documentClient, allowVp());
    const { handler } = await import('./hoursHandler.js');

    const selfResult = await handler(
      buildEvent({ principal: PRINCIPAL, query: { memberId: 'member-1', from: '0', to: '10' } }),
    );
    const selfBody = JSON.parse((selfResult as { body: string }).body) as {
      categories: Array<{ category: string; hours: number }>;
    };

    const OFFICER = { sub: 'officer-1', deptId: 'dept-001', 'cognito:groups': 'training' };
    const officerResult = await handler(
      buildEvent({ principal: OFFICER, query: { from: '0', to: '10' } }),
    );
    const officerBody = JSON.parse((officerResult as { body: string }).body) as {
      members: Array<{ memberId: string; categories: Array<{ category: string; hours: number }> }>;
    };

    const rosterMember1 = officerBody.members.find((member) => member.memberId === 'member-1');
    expect(rosterMember1?.categories).toEqual(selfBody.categories);
    expect(selfBody.categories).toEqual([{ category: 'fireground', hours: 4 }]);
  });

  it('returns 503 problem+json (not a rejected promise) when TRAINING_TABLE_NAME is unset', async () => {
    delete process.env.TRAINING_TABLE_NAME;
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, allowVp());
    const { handler } = await import('./hoursHandler.js');
    const result = await handler(
      buildEvent({ principal: PRINCIPAL, query: { memberId: 'member-1', from: '0', to: '10' } }),
    );
    expect(result).toMatchObject({ statusCode: 503 });
    const body = JSON.parse((result as { body: string }).body) as { traceId?: string };
    expect(body.traceId).toBeDefined();
  });

  it('returns 503 problem+json (not a rejected promise) when VERIFIED_PERMISSIONS_POLICY_STORE_ID is unset', async () => {
    delete process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID;
    const { handler } = await import('./hoursHandler.js');
    const result = await handler(
      buildEvent({ principal: PRINCIPAL, query: { from: '0', to: '10' } }),
    );
    expect(result).toMatchObject({ statusCode: 503 });
    const body = JSON.parse((result as { body: string }).body) as { traceId?: string };
    expect(body.traceId).toBeDefined();
  });
});
