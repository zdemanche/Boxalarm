import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent } from '@boxalarm/authz';

const PRINCIPAL = { sub: 'officer-1', deptId: 'dept-001', 'cognito:groups': 'training' };
const VALID_BODY = JSON.stringify({
  title: 'Ladder Ops',
  category: 'fireground',
  startAt: 1_000,
  endAt: 2_000,
});

function buildEvent(body: string | undefined): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/training/events',
    rawPath: '/api/v1/training/events',
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    body,
    requestContext: { authorizer: { lambda: PRINCIPAL } },
  } as unknown as GuardEvent;
}

function vpClient(decision: 'ALLOW' | 'DENY' | 'ERROR'): VerifiedPermissionsClient {
  return {
    send:
      decision === 'ERROR'
        ? vi.fn().mockRejectedValue(new Error('VP outage'))
        : vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

function fakeDocumentClient(sendImpl: (command: unknown) => unknown): DynamoDBDocumentClient {
  return { send: vi.fn(sendImpl) } as unknown as DynamoDBDocumentClient;
}

describe('createEventHandler (POST /training/events)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.TRAINING_TABLE_NAME = 'platform-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('creates a TRAINING_EVENT and returns 201 for an authorized training officer (AC1, entrypoint-test)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, vpClient('ALLOW'));
    const { createDocumentClient } = await import('./client.js');
    createDocumentClient(
      process.env,
      fakeDocumentClient(() => ({})),
    );
    const { handler } = await import('./createEventHandler.js');

    const result = await handler(buildEvent(VALID_BODY));

    expect(result).toMatchObject({ statusCode: 201 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Ladder Ops', category: 'fireground' });
  });

  it('returns 400 without ever calling authorization or the store when required fields are missing (bad-request row)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, vpClient('ALLOW'));
    const { handler } = await import('./createEventHandler.js');

    const result = await handler(buildEvent(JSON.stringify({ title: 'Ladder Ops' })));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('denies a non-officer principal before ever creating an event (403 row, core-harm)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, vpClient('DENY'));
    const { createDocumentClient } = await import('./client.js');
    const putSpy = vi.fn(() => ({}));
    createDocumentClient(process.env, fakeDocumentClient(putSpy));
    const { handler } = await import('./createEventHandler.js');

    const result = await handler(buildEvent(VALID_BODY));

    expect(result).toMatchObject({ statusCode: 403 });
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('returns 503 without creating an event when Verified Permissions is unavailable (503 row)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, vpClient('ERROR'));
    const { createDocumentClient } = await import('./client.js');
    const putSpy = vi.fn(() => ({}));
    createDocumentClient(process.env, fakeDocumentClient(putSpy));
    const { handler } = await import('./createEventHandler.js');

    const result = await handler(buildEvent(VALID_BODY));

    expect(result).toMatchObject({ statusCode: 503 });
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('returns 503 without an unhandled throw when the DynamoDB write rejects (write-failure row)', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, vpClient('ALLOW'));
    const { createDocumentClient } = await import('./client.js');
    createDocumentClient(
      process.env,
      fakeDocumentClient(() => {
        throw new Error('DynamoDB unavailable');
      }),
    );
    const { handler } = await import('./createEventHandler.js');

    const result = await handler(buildEvent(VALID_BODY));

    expect(result).toMatchObject({ statusCode: 503 });
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
