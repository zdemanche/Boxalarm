import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { BatchGetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent } from '@boxalarm/authz';

const NOW = 1_800_000_000;
const originalEnv = { ...process.env };

beforeEach(() => {
  // @boxalarm/authz caches its Verified Permissions client per module instance.
  vi.resetModules();
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  process.env.INCIDENT_TABLE_NAME = 'incident';
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function event(query?: Record<string, string>, deptId = 'NICHOLS'): GuardEvent {
  return {
    version: '2.0',
    headers: { authorization: 'Bearer token' },
    queryStringParameters: query,
    requestContext: {
      requestId: 'req-1',
      authorizer: { lambda: { sub: 'chief-1', deptId, 'cognito:groups': 'CHIEF' } },
    },
  } as unknown as GuardEvent;
}

function copy(dispatchId: string, dispatchedAt: number) {
  return {
    pk: `DEPT#NICHOLS#DISPATCH_COPY#${dispatchId}`,
    sk: 'METADATA',
    dispatchId,
    incidentType: 'STRUCTURE FIRE',
    address: '1 Main St',
    narrative: 'smoke showing',
    dispatchedAt,
  };
}

function fakeClient(
  pages: { Items: unknown[]; LastEvaluatedKey?: unknown }[],
  reports: unknown[] = [],
) {
  const queue = [...pages];
  const send = vi.fn((command: unknown) => {
    if (command instanceof QueryCommand) return Promise.resolve(queue.shift() ?? { Items: [] });
    if (command instanceof BatchGetCommand) {
      return Promise.resolve({ Responses: { incident: reports } });
    }
    return Promise.reject(new Error('unexpected command'));
  });
  return { client: { send } as unknown as DynamoDBDocumentClient, send };
}

async function handlerFor(client: DynamoDBDocumentClient, decision: 'ALLOW' | 'DENY' = 'ALLOW') {
  const { createListRecentDispatchesHandler } = await import('./listRecentDispatches.js');
  return createListRecentDispatchesHandler({
    client,
    tableName: 'incident',
    nowSeconds: () => NOW,
    authzClient: {
      send: vi.fn().mockResolvedValue({ decision: Decision[decision] }),
    } as unknown as VerifiedPermissionsClient,
  });
}

function body(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { body: string }).body) as Record<string, unknown>;
}

describe('GET /incidents/dispatches', () => {
  it('returns 403 when Cedar denies ListRecentDispatches, without reading the table', async () => {
    const { client, send } = fakeClient([]);
    const result = await (await handlerFor(client, 'DENY'))(event());
    expect(result).toMatchObject({ statusCode: 403 });
    expect(send).not.toHaveBeenCalled();
  });

  it('lists the last 72 hours newest first from the dept GSI1 partition, with any report started', async () => {
    const { client, send } = fakeClient(
      [{ Items: [copy('d-2', NOW - 3600), copy('d-1', NOW - 50 * 3600)] }],
      [{ incidentId: 'd-1', status: 'DRAFT' }],
    );
    const result = await (await handlerFor(client))(event());

    expect(result).toMatchObject({ statusCode: 200 });
    const payload = body(result);
    expect(payload.recentWindowHours).toBe(72);
    expect(payload.dispatches).toEqual([
      {
        dispatchId: 'd-2',
        incidentType: 'STRUCTURE FIRE',
        address: '1 Main St',
        dispatchedAt: NOW - 3600,
        report: null,
      },
      {
        dispatchId: 'd-1',
        incidentType: 'STRUCTURE FIRE',
        address: '1 Main St',
        dispatchedAt: NOW - 50 * 3600,
        report: { incidentId: 'd-1', status: 'DRAFT' },
      },
    ]);
    const query = send.mock.calls[0]?.[0] as QueryCommand;
    expect(query.input).toMatchObject({
      IndexName: 'GSI1',
      ScanIndexForward: false,
      ExpressionAttributeValues: {
        ':pk': 'DEPT#NICHOLS',
        ':from': `DISPATCH#${NOW - 72 * 3600}`,
        ':to': `DISPATCH#${NOW}`,
      },
    });
    const batch = send.mock.calls[1]?.[0] as BatchGetCommand;
    expect(batch.input.RequestItems?.incident?.Keys).toEqual([
      { pk: 'DEPT#NICHOLS#INCIDENT#d-2', sk: 'METADATA' },
      { pk: 'DEPT#NICHOLS#INCIDENT#d-1', sk: 'METADATA' },
    ]);
    // Narrative stays out of the list.
    expect(JSON.stringify(payload)).not.toContain('smoke showing');
  });

  it('hands out a cursor to older dispatches, and pages them `limit` at a time', async () => {
    const first = fakeClient([{ Items: [] }]);
    const cursor = body(await (await handlerFor(first.client))(event())).nextCursor as string;
    expect(typeof cursor).toBe('string');

    const lek = {
      pk: 'DEPT#NICHOLS#DISPATCH_COPY#d-0',
      sk: 'METADATA',
      gsi1pk: 'DEPT#NICHOLS',
      gsi1sk: 'DISPATCH#1',
    };
    const older = fakeClient([{ Items: [copy('d-0', NOW - 100 * 3600)], LastEvaluatedKey: lek }]);
    const page = body(await (await handlerFor(older.client))(event({ cursor, limit: '10' })));
    const query = older.send.mock.calls[0]?.[0] as QueryCommand;
    expect(query.input.Limit).toBe(10);
    expect(query.input.ExpressionAttributeValues).toMatchObject({
      ':from': 'DISPATCH#0',
      ':to': `DISPATCH#${NOW - 72 * 3600 - 1}`,
    });
    expect((page.dispatches as unknown[]).length).toBe(1);

    const last = fakeClient([{ Items: [] }]);
    await (
      await handlerFor(last.client)
    )(event({ cursor: page.nextCursor as string }));
    expect((last.send.mock.calls[0]?.[0] as QueryCommand).input.ExclusiveStartKey).toEqual(lek);
  });

  it("refuses another department's cursor and a malformed one", async () => {
    const foreign = Buffer.from(
      JSON.stringify({
        from: 0,
        to: 10,
        lek: { pk: 'x', sk: 'y', gsi1pk: 'DEPT#OTHER', gsi1sk: 'DISPATCH#1' },
      }),
    ).toString('base64url');
    const { client, send } = fakeClient([]);
    const handler = await handlerFor(client);
    expect(await handler(event({ cursor: foreign }))).toMatchObject({ statusCode: 400 });
    expect(await handler(event({ cursor: 'not-json' }))).toMatchObject({ statusCode: 400 });
    expect(await handler(event({ limit: '1000' }))).toMatchObject({ statusCode: 400 });
    expect(send).not.toHaveBeenCalled();
  });

  it('answers 503, not a crash, when the table read fails', async () => {
    const send = vi.fn().mockRejectedValue(new Error('throttled'));
    const result = await (await handlerFor({ send } as unknown as DynamoDBDocumentClient))(event());
    expect(result).toMatchObject({ statusCode: 503 });
  });
});
