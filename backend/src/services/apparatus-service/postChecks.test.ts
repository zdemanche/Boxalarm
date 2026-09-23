import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const logErrorSpy = vi.fn<(fields: Record<string, unknown>) => void>();
vi.mock('./logger.js', () => ({ logError: logErrorSpy, logInfo: vi.fn() }));

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  logErrorSpy.mockClear();
  process.env.PLATFORM_TABLE_NAME = 'platform-table';
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'member-1',
  deptId: 'dept-001',
  'cognito:groups': 'apparatus',
};

const APPARATUS_PK = 'DEPT#dept-001#APPARATUS#apparatus-1';

function buildEvent(
  body: string | undefined,
  unitId: string | undefined,
  principal: Partial<CedarPrincipalContext> | null | undefined = PRINCIPAL,
  headers: Record<string, string> = { authorization: 'Bearer token' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/apparatus/{unitId}/checks',
    rawPath: `/api/v1/apparatus/${unitId ?? ''}/checks`,
    rawQueryString: '',
    headers,
    pathParameters: unitId !== undefined ? { unitId } : undefined,
    body,
    requestContext: {
      authorizer: { lambda: principal ?? undefined },
    },
  } as unknown as GuardEvent;
}

function fakeAuthzClient(decision: 'ALLOW' | 'DENY' | Error = 'ALLOW'): VerifiedPermissionsClient {
  return {
    send:
      decision instanceof Error
        ? vi.fn().mockRejectedValue(decision)
        : vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

interface PutItem {
  readonly TableName: string;
  readonly Item: Record<string, unknown>;
  readonly ConditionExpression?: string;
}

function keyOf(pk: string, sk: string): string {
  return `${pk}#${sk}`;
}

function statefulDynamoClient(apparatusExists: boolean): DynamoDBDocumentClient {
  const store = new Map<string, Record<string, unknown>>();
  const send = vi.fn((command: unknown) => {
    if (command instanceof QueryCommand) {
      return Promise.resolve(apparatusExists ? { Items: [{ pk: APPARATUS_PK }] } : { Items: [] });
    }
    if (command instanceof TransactWriteCommand) {
      const items = command.input.TransactItems ?? [];
      const puts = items
        .map((transactItem) => transactItem.Put)
        .filter((put): put is PutItem => put !== undefined);
      const reasons = puts.map((put) => {
        const pk = put.Item.pk as string;
        const sk = put.Item.sk as string;
        const exists = store.has(keyOf(pk, sk));
        const requiresAbsence = put.ConditionExpression?.includes('attribute_not_exists');
        return { Code: requiresAbsence && exists ? 'ConditionalCheckFailed' : 'None' };
      });
      if (reasons.some((reason) => reason.Code === 'ConditionalCheckFailed')) {
        return Promise.reject(
          new TransactionCanceledException({
            message: 'Transaction cancelled',
            $metadata: {},
            CancellationReasons: reasons,
          }),
        );
      }
      puts.forEach((put) => {
        store.set(keyOf(put.Item.pk as string, put.Item.sk as string), put.Item);
      });
      return Promise.resolve({});
    }
    if (command instanceof GetCommand) {
      const { pk, sk } = command.input.Key as { pk: string; sk: string };
      const item = store.get(keyOf(pk, sk));
      return Promise.resolve(item ? { Item: item } : {});
    }
    return Promise.reject(new Error('unexpected command'));
  });
  return { send } as unknown as DynamoDBDocumentClient;
}

function fakeDynamoClient(options: {
  readonly apparatusExists: boolean;
  readonly transactError?: Error;
  readonly getResponses?: Record<string, Record<string, unknown>>;
}): DynamoDBDocumentClient {
  const send = vi.fn((command: unknown) => {
    if (command instanceof QueryCommand) {
      return Promise.resolve(
        options.apparatusExists ? { Items: [{ pk: APPARATUS_PK }] } : { Items: [] },
      );
    }
    if (command instanceof TransactWriteCommand) {
      return options.transactError ? Promise.reject(options.transactError) : Promise.resolve({});
    }
    if (command instanceof GetCommand) {
      const { pk, sk } = command.input.Key as { pk: string; sk: string };
      const item = options.getResponses?.[keyOf(pk, sk)];
      return Promise.resolve(item ? { Item: item } : {});
    }
    return Promise.reject(new Error('unexpected command'));
  });
  return { send } as unknown as DynamoDBDocumentClient;
}

const NOW = () => 1798052000;

function findChecklistRunItem(client: DynamoDBDocumentClient): Record<string, unknown> {
  const call = (client.send as ReturnType<typeof vi.fn>).mock.calls.find(
    (call: unknown[]) => call[0] instanceof TransactWriteCommand,
  ) as [TransactWriteCommand] | undefined;
  const items = call?.[0].input.TransactItems ?? [];
  return items[0]?.Put?.Item as Record<string, unknown>;
}

function transactWriteCallCount(client: DynamoDBDocumentClient): number {
  return (client.send as ReturnType<typeof vi.fn>).mock.calls.filter(
    (call: unknown[]) => call[0] instanceof TransactWriteCommand,
  ).length;
}

function validBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    templateId: 'template-1',
    completedBy: 'member-1',
    completedAt: 1798052000,
    durationSeconds: 82,
    idempotencyKey: 'idem-1',
    itemResults: [{ code: 'BRAKES', pass: true }],
    ...overrides,
  });
}

async function importHandler() {
  const { createPostChecksHandler } = await import('./postChecks.js');
  return createPostChecksHandler;
}

describe('postChecks handler', () => {
  it('returns 403 forbidden on a Cedar deny', async () => {
    const createPostChecksHandler = await importHandler();
    const handler = createPostChecksHandler({
      client: statefulDynamoClient(true),
      authzClient: fakeAuthzClient('DENY'),
      now: NOW,
    });
    const result = await handler(buildEvent(validBody(), 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 fail-closed when Verified Permissions is unavailable', async () => {
    const createPostChecksHandler = await importHandler();
    const handler = createPostChecksHandler({
      client: statefulDynamoClient(true),
      authzClient: fakeAuthzClient(new Error('VP outage')),
      now: NOW,
    });
    const result = await handler(buildEvent(validBody(), 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 400 when unitId path parameter is missing', async () => {
    const createPostChecksHandler = await importHandler();
    const handler = createPostChecksHandler({
      client: statefulDynamoClient(true),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent(validBody(), undefined));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 404 apparatus-not-found when no apparatus resolves for the unitId', async () => {
    const createPostChecksHandler = await importHandler();
    const handler = createPostChecksHandler({
      client: statefulDynamoClient(false),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent(validBody(), 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 400 and logs the original parse error on malformed JSON', async () => {
    const createPostChecksHandler = await importHandler();
    const handler = createPostChecksHandler({
      client: statefulDynamoClient(true),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent('{not json', 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 400 });
    expect(logErrorSpy).toHaveBeenCalledWith(expect.objectContaining({ reason: 'MalformedJson' }));
  });

  it('returns 400 validation-error with field errors when required fields are missing', async () => {
    const createPostChecksHandler = await importHandler();
    const handler = createPostChecksHandler({
      client: statefulDynamoClient(true),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent('{}', 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as { errors: unknown[] };
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it('returns 400 when completedBy does not match the authenticated principal', async () => {
    const createPostChecksHandler = await importHandler();
    const handler = createPostChecksHandler({
      client: statefulDynamoClient(true),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(
      buildEvent(validBody({ completedBy: 'someone-else' }), 'ENGINE-2'),
    );
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as {
      errors: { field: string }[];
    };
    expect(body.errors).toContainEqual(expect.objectContaining({ field: 'completedBy' }));
  });

  it('creates a CHECKLIST_RUN with completedBy/completedAt/itemResults/durationSeconds and returns 201 (AC1)', async () => {
    const dynamoClient = statefulDynamoClient(true);
    const createPostChecksHandler = await importHandler();
    const handler = createPostChecksHandler({
      client: dynamoClient,
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent(validBody(), 'ENGINE-2'));

    expect(result).toMatchObject({ statusCode: 201 });
    const putItem = findChecklistRunItem(dynamoClient);
    expect(putItem.entityType).toBe('CHECKLIST_RUN');
    expect(putItem.pk).toBe(APPARATUS_PK);
    expect(putItem.sk).toBe('CHECK#1798052000');
    expect(putItem.completedBy).toBe('member-1');
    expect(putItem.completedAt).toBe(1798052000);
    expect(putItem.durationSeconds).toBe(82);
    expect(putItem.itemResults).toEqual([{ code: 'BRAKES', pass: true, note: null }]);
  });

  it('writes an AUDIT_LOG_ENTRY for the submitting principal in the same transaction (F9.4)', async () => {
    const dynamoClient = statefulDynamoClient(true);
    const createPostChecksHandler = await importHandler();
    const handler = createPostChecksHandler({
      client: dynamoClient,
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent(validBody(), 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 201 });

    const call = (dynamoClient.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => call[0] instanceof TransactWriteCommand,
    ) as [TransactWriteCommand];
    const items = call[0].input.TransactItems ?? [];
    const auditItem = items[2]?.Put?.Item as Record<string, unknown>;
    expect(auditItem.entityType).toBe('AUDIT_LOG_ENTRY');
    expect(auditItem.mutatedEntityType).toBe('CHECKLIST_RUN');
    expect(auditItem.actorId).toBe('member-1');
  });

  it('persists capturedOffline: true verbatim without recomputing durationSeconds from server time (AC3)', async () => {
    const dynamoClient = statefulDynamoClient(true);
    const createPostChecksHandler = await importHandler();
    const handler = createPostChecksHandler({
      client: dynamoClient,
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(
      buildEvent(
        validBody({ capturedOffline: true, durationSeconds: 41, completedAt: 1690000000 }),
        'ENGINE-2',
      ),
    );

    expect(result).toMatchObject({ statusCode: 201 });
    const putItem = findChecklistRunItem(dynamoClient);
    expect(putItem.capturedOffline).toBe(true);
    expect(putItem.durationSeconds).toBe(41);
    expect(putItem.syncedAt).toEqual(expect.any(Number));
  });

  it('returns 200 with the existing record on a replayed submit with the same idempotencyKey, without a second write (AC4)', async () => {
    const dynamoClient = statefulDynamoClient(true);
    const createPostChecksHandler = await importHandler();
    const handler = createPostChecksHandler({
      client: dynamoClient,
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const first = await handler(buildEvent(validBody(), 'ENGINE-2'));
    expect(first).toMatchObject({ statusCode: 201 });

    const replay = await handler(buildEvent(validBody(), 'ENGINE-2'));
    expect(replay).toMatchObject({ statusCode: 200 });
    const replayBody = JSON.parse((replay as { body: string }).body) as {
      completedAt: number;
    };
    expect(replayBody.completedAt).toBe(1798052000);
  });

  it('exactly-once holds when a retry recomputes completedAt under the same idempotencyKey', async () => {
    const dynamoClient = statefulDynamoClient(true);
    const createPostChecksHandler = await importHandler();
    const handler = createPostChecksHandler({
      client: dynamoClient,
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const first = await handler(buildEvent(validBody(), 'ENGINE-2'));
    expect(first).toMatchObject({ statusCode: 201 });

    const retry = await handler(buildEvent(validBody({ completedAt: 1798052999 }), 'ENGINE-2'));
    expect(retry).toMatchObject({ statusCode: 200 });
    const retryBody = JSON.parse((retry as { body: string }).body) as { completedAt: number };
    expect(retryBody.completedAt).toBe(1798052000);
    expect(transactWriteCallCount(dynamoClient)).toBe(2);
  });

  it('returns 409 conflict when the sk collides with a different idempotencyKey', async () => {
    const dynamoClient = statefulDynamoClient(true);
    const createPostChecksHandler = await importHandler();
    const handler = createPostChecksHandler({
      client: dynamoClient,
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const first = await handler(buildEvent(validBody(), 'ENGINE-2'));
    expect(first).toMatchObject({ statusCode: 201 });

    const conflicting = await handler(
      buildEvent(validBody({ idempotencyKey: 'idem-2' }), 'ENGINE-2'),
    );
    expect(conflicting).toMatchObject({ statusCode: 409 });
  });

  it('returns 503 when the idempotency lock reports a conflict but the referenced run cannot be read back', async () => {
    const dynamoClient = fakeDynamoClient({
      apparatusExists: true,
      transactError: new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
        ],
      }),
      getResponses: {},
    });
    const createPostChecksHandler = await importHandler();
    const handler = createPostChecksHandler({
      client: dynamoClient,
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent(validBody(), 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 503, not 409, when a conditional failure re-read finds no item (transient/unknown state)', async () => {
    const dynamoClient = fakeDynamoClient({
      apparatusExists: true,
      transactError: new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
          { Code: 'None' },
        ],
      }),
      getResponses: {},
    });
    const createPostChecksHandler = await importHandler();
    const handler = createPostChecksHandler({
      client: dynamoClient,
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent(validBody(), 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 503 });
    expect(logErrorSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'putChecklistRun' }),
    );
  });

  it('returns 503 fail-closed and logs the original error when DynamoDB is unavailable, without assuming a partial write succeeded', async () => {
    const dynamoClient = fakeDynamoClient({
      apparatusExists: true,
      transactError: new Error('table throttled'),
    });
    const createPostChecksHandler = await importHandler();
    const handler = createPostChecksHandler({
      client: dynamoClient,
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent(validBody(), 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 503 });
    const [lastCall] = logErrorSpy.mock.calls.at(-1) ?? [];
    expect(lastCall?.message).toContain('table throttled');
  });
});
