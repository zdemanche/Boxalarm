import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent } from '@boxalarm/authz';

const PRINCIPAL = { sub: 'member-1', deptId: 'dept-001', 'cognito:groups': 'member' };

function buildEvent(principal: Record<string, string> | undefined): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/training/events',
    rawPath: '/api/v1/training/events',
    rawQueryString: '',
    headers: {},
    requestContext: { authorizer: { lambda: principal } },
  } as unknown as GuardEvent;
}

function fakeDocumentClient(sendImpl: (command: unknown) => unknown): DynamoDBDocumentClient {
  return { send: vi.fn(sendImpl) } as unknown as DynamoDBDocumentClient;
}

describe('listEventsHandler (GET /training/events)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.TRAINING_TABLE_NAME = 'platform-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('lists GSI3-ordered events and marks signedUp true only for events the member attended (AC1, AC4, entrypoint-test)', async () => {
    const { createDocumentClient } = await import('./client.js');
    createDocumentClient(
      process.env,
      fakeDocumentClient((command) => {
        const c = command as { input: { IndexName?: string } };
        if (c.input.IndexName === 'GSI3') {
          return {
            Items: [
              { eventId: 'e1', title: 'Drill 1', category: 'ems', startAt: 100, endAt: 200 },
              { eventId: 'e2', title: 'Drill 2', category: 'ems', startAt: 300, endAt: 400 },
            ],
          };
        }
        return { Items: [{ eventId: 'e1' }] };
      }),
    );
    const { handler } = await import('./listEventsHandler.js');

    const result = await handler(buildEvent(PRINCIPAL));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as Array<{
      eventId: string;
      signedUp: boolean;
    }>;
    expect(body.map((e) => e.eventId)).toEqual(['e1', 'e2']);
    expect(body.find((e) => e.eventId === 'e1')?.signedUp).toBe(true);
    expect(body.find((e) => e.eventId === 'e2')?.signedUp).toBe(false);
  });

  it('returns 403 when the authorizer principal is missing or invalid (tenancy boundary)', async () => {
    const { handler } = await import('./listEventsHandler.js');

    const result = await handler(buildEvent(undefined));

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 (fail-closed, not partial data) when the DynamoDB Query fails', async () => {
    const { createDocumentClient } = await import('./client.js');
    createDocumentClient(
      process.env,
      fakeDocumentClient(() => {
        throw new Error('DynamoDB unavailable');
      }),
    );
    const { handler } = await import('./listEventsHandler.js');

    const result = await handler(buildEvent(PRINCIPAL));

    expect(result).toMatchObject({ statusCode: 503 });
  });
});
