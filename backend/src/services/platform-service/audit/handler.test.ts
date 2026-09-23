import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../authorizer/handler.js';
import { buildAuditLogEntryTransactItem } from './auditEntry.js';

const DEPT_ID: VerifiedDeptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

function buildEvent(options: {
  groups?: string;
  queryStringParameters?: Record<string, string>;
  headers?: Record<string, string>;
}): APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext> {
  const event = {
    version: '2.0',
    routeKey: 'GET /api/v1/platform/audit',
    rawPath: '/api/v1/platform/audit',
    rawQueryString: '',
    headers: options.headers ?? {},
    ...(options.queryStringParameters !== undefined
      ? { queryStringParameters: options.queryStringParameters }
      : {}),
    isBase64Encoded: false,
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.boxalarm.dev',
      domainPrefix: 'api',
      http: {
        method: 'GET',
        path: '/api/v1/platform/audit',
        protocol: 'HTTP/1.1',
        sourceIp: '203.0.113.1',
        userAgent: 'vitest',
      },
      requestId: 'req-1',
      routeKey: 'GET /api/v1/platform/audit',
      stage: '$default',
      time: '03/Sep/2026:00:00:00 +0000',
      timeEpoch: 1788436800000,
      authorizer: {
        lambda: {
          sub: 'MBR-0034',
          deptId: DEPT_ID,
          'cognito:groups': options.groups ?? 'CHIEF',
        },
      },
    },
  };
  return event;
}

function createFakeDocumentClient() {
  const items: Record<string, unknown>[] = [];
  return {
    items,
    send: vi.fn((command: unknown) => {
      if (command instanceof TransactWriteCommand) {
        for (const transactItem of command.input.TransactItems ?? []) {
          if (transactItem.Put?.Item) {
            items.push(transactItem.Put.Item as Record<string, unknown>);
          }
        }
        return Promise.resolve({});
      }
      if (command instanceof QueryCommand) {
        const gsi3pk = (command.input.ExpressionAttributeValues as Record<string, unknown>)?.[
          ':gsi3pk'
        ];
        return Promise.resolve({ Items: items.filter((item) => item.gsi3pk === gsi3pk) });
      }
      return Promise.reject(new Error('unsupported command in fake client'));
    }),
  };
}

describe('handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.AUDIT_TABLE_NAME = 'platform-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('./dynamoClient.js');
    vi.restoreAllMocks();
  });

  it('denies with 403 problem+json when the caller lacks the chief/admin/officer role', async () => {
    const { handler } = await import('./handler.js');
    const result = (await handler(
      buildEvent({ groups: 'MEMBER' }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; headers: Record<string, string>; body: string };
    expect(result.statusCode).toBe(403);
    expect(result.headers['content-type']).toBe('application/problem+json');
    expect((JSON.parse(result.body) as { traceId: string }).traceId).toBeTruthy();
  });

  it('returns 400 problem+json when entityType/entityId are absent', async () => {
    const { handler } = await import('./handler.js');
    const result = (await handler(
      buildEvent({ queryStringParameters: {} }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; headers: Record<string, string>; body: string };
    expect(result.statusCode).toBe(400);
    expect(result.headers['content-type']).toBe('application/problem+json');
    const body = JSON.parse(result.body) as { title: string; detail: string; traceId: string };
    expect(body.title).toBe('Bad Request');
    expect(body.detail).toMatch(/entityType and entityId/);
    expect(body.traceId).toBeTruthy();
  });

  it('returns 400 when entityId is present but empty', async () => {
    const { handler } = await import('./handler.js');
    const result = (await handler(
      buildEvent({ queryStringParameters: { entityType: 'CERTIFICATION', entityId: '' } }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; headers: Record<string, string>; body: string };
    expect(result.statusCode).toBe(400);
    expect(result.headers['content-type']).toBe('application/problem+json');
    const body = JSON.parse(result.body) as { title: string; detail: string };
    expect(body.title).toBe('Bad Request');
    expect(body.detail).toMatch(/entityType and entityId/);
  });

  it('returns 400 when entityId arrives as a repeated (comma-joined) query param', async () => {
    const { handler } = await import('./handler.js');
    const result = (await handler(
      buildEvent({
        queryStringParameters: { entityType: 'CERTIFICATION', entityId: 'CERT-1,CERT-2' },
      }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; headers: Record<string, string>; body: string };
    expect(result.statusCode).toBe(400);
    expect(result.headers['content-type']).toBe('application/problem+json');
    const body = JSON.parse(result.body) as { title: string; detail: string };
    expect(body.title).toBe('Bad Request');
    expect(body.detail).toMatch(/entityType and entityId/);
  });

  it('returns 400 (not 503) when entityId contains the pk delimiter "#"', async () => {
    const { handler } = await import('./handler.js');
    const result = (await handler(
      buildEvent({
        queryStringParameters: { entityType: 'CERTIFICATION', entityId: 'CERT#1' },
      }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; headers: Record<string, string>; body: string };
    expect(result.statusCode).toBe(400);
    expect(result.headers['content-type']).toBe('application/problem+json');
    const body = JSON.parse(result.body) as { title: string; detail: string };
    expect(body.title).toBe('Bad Request');
    expect(body.detail).toMatch(/entityType and entityId/);
  });

  it('returns 400 (not 503) with Reason=InvalidCursor when the cursor is malformed', async () => {
    vi.doMock('./dynamoClient.js', () => ({
      getDocumentClient: () => ({ send: vi.fn() }),
      readAuditConfig: () => ({ tableName: 'platform-table' }),
      AuditConfigError: class AuditConfigError extends Error {},
      logger: { error: vi.fn() },
    }));
    const { handler } = await import('./handler.js');
    const result = (await handler(
      buildEvent({
        queryStringParameters: {
          entityType: 'CERTIFICATION',
          entityId: 'CERT-0091',
          cursor: 'not-valid-base64url-json',
        },
      }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; headers: Record<string, string>; body: string };
    expect(result.statusCode).toBe(400);
    expect(result.headers['content-type']).toBe('application/problem+json');
    const body = JSON.parse(result.body) as { title: string; detail: string; traceId: string };
    expect(body.title).toBe('Bad Request');
    expect(body.detail).toMatch(/cursor/);
    expect(body.traceId).toBeTruthy();
  });

  it('returns 500 (not 503) when the service is misconfigured (AUDIT_TABLE_NAME unset)', async () => {
    delete process.env.AUDIT_TABLE_NAME;
    const { handler } = await import('./handler.js');
    const result = (await handler(
      buildEvent({
        queryStringParameters: { entityType: 'CERTIFICATION', entityId: 'CERT-0091' },
      }),
      {} as never,
      () => undefined,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(500);
  });

  it('returns 200 with an empty entries array when the record has zero audit entries', async () => {
    const fakeClient = createFakeDocumentClient();
    vi.doMock('./dynamoClient.js', () => ({
      getDocumentClient: () => fakeClient,
      readAuditConfig: () => ({ tableName: 'platform-table' }),
    }));
    const { handler } = await import('./handler.js');
    const result = (await handler(
      buildEvent({
        queryStringParameters: { entityType: 'CERTIFICATION', entityId: 'CERT-NEW' },
      }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ entries: [] });
  });

  it('fails closed with 503 problem+json when the DynamoDB query is unavailable', async () => {
    const loggedEntries: Record<string, unknown>[] = [];
    vi.doMock('./dynamoClient.js', () => ({
      getDocumentClient: () => ({ send: vi.fn().mockRejectedValue(new Error('throttled')) }),
      readAuditConfig: () => ({ tableName: 'platform-table' }),
      AuditConfigError: class AuditConfigError extends Error {},
      logger: {
        error: (entry: Record<string, unknown>) => {
          loggedEntries.push(entry);
        },
      },
    }));
    const { handler } = await import('./handler.js');
    const result = (await handler(
      buildEvent({
        queryStringParameters: { entityType: 'CERTIFICATION', entityId: 'CERT-0091' },
      }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; headers: Record<string, string> };
    expect(result.statusCode).toBe(503);
    expect(result.headers['content-type']).toBe('application/problem+json');
    expect(loggedEntries).toHaveLength(1);
    expect(loggedEntries[0]?.event).toBe('audit.query.failed');
    expect(typeof loggedEntries[0]?.traceId).toBe('string');
  });

  it('emits the AuditQueryServed business metric on a successful query', async () => {
    const fakeClient = createFakeDocumentClient();
    vi.doMock('./dynamoClient.js', () => ({
      getDocumentClient: () => fakeClient,
      readAuditConfig: () => ({ tableName: 'platform-table' }),
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./handler.js');
    await handler(
      buildEvent({
        queryStringParameters: { entityType: 'CERTIFICATION', entityId: 'CERT-NEW' },
      }),
      {} as never,
      () => undefined,
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('AuditQueryServed'));
  });

  it('write → read round trip: a written audit entry is returned by GET /platform/audit with actor and changedFields (core-harm)', async () => {
    const fakeClient = createFakeDocumentClient();
    // Composed the way a real mutating service does: the audit transact item goes into
    // the caller's own TransactWriteItems call, not a separate write.
    const transactItem = buildAuditLogEntryTransactItem('platform-table', {
      deptId: DEPT_ID,
      actorId: 'MBR-0034',
      mutatedEntityType: 'CERTIFICATION',
      mutatedEntityId: 'CERT-0091',
      action: 'UPDATE',
      before: { expiryDate: '2026-01-10' },
      after: { expiryDate: '2027-01-10' },
    });
    await fakeClient.send(new TransactWriteCommand({ TransactItems: [transactItem] }));

    vi.doMock('./dynamoClient.js', () => ({
      getDocumentClient: () => fakeClient,
      readAuditConfig: () => ({ tableName: 'platform-table' }),
    }));
    const { handler } = await import('./handler.js');
    const result = (await handler(
      buildEvent({
        queryStringParameters: { entityType: 'CERTIFICATION', entityId: 'CERT-0091' },
      }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as {
      entries: { actorId: string; changedFields: Record<string, unknown> }[];
    };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.actorId).toBe('MBR-0034');
    expect(body.entries[0]?.changedFields).toEqual({
      expiryDate: { old: '2026-01-10', new: '2027-01-10' },
    });
  });
});
