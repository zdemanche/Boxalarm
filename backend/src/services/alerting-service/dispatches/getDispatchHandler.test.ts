import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent } from '@boxalarm/authz';

const PRINCIPAL = { sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': 'member' };

function buildEvent(
  dispatchId = 'DISPATCH-1',
  headers: Record<string, string> = { authorization: 'Bearer token' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/alerting/dispatches/{dispatchId}',
    rawPath: `/api/v1/alerting/dispatches/${dispatchId}`,
    rawQueryString: '',
    headers,
    pathParameters: { dispatchId },
    requestContext: { authorizer: { lambda: PRINCIPAL } },
  } as unknown as GuardEvent;
}

function allowClient(): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision.ALLOW }),
  } as unknown as VerifiedPermissionsClient;
}

function fakeDoc(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('getDispatchHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.ALERTING_DISPATCHES_TABLE_NAME = 'alerting-dispatches-table';
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 401 (fail-closed) on a missing bearer token via the real exported handler, before any AWS call (entrypoint test)', async () => {
    const { handler } = await import('./getDispatchHandler.js');
    const result = await handler(buildEvent('DISPATCH-1', {}));
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 403 on a Cedar deny', async () => {
    const { createGetDispatchHandler } = await import('./getDispatchHandler.js');
    const denyClient = {
      send: vi.fn().mockResolvedValue({ decision: Decision.DENY }),
    } as unknown as VerifiedPermissionsClient;
    const wrapped = createGetDispatchHandler(fakeDoc(vi.fn()), fakeDoc(vi.fn()), denyClient);
    const result = await wrapped(buildEvent());
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 when Verified Permissions is unavailable', async () => {
    const { createGetDispatchHandler } = await import('./getDispatchHandler.js');
    const unavailableClient = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    const wrapped = createGetDispatchHandler(fakeDoc(vi.fn()), fakeDoc(vi.fn()), unavailableClient);
    const result = await wrapped(buildEvent());
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 400 when dispatchId is missing from the path', async () => {
    const { createGetDispatchHandler } = await import('./getDispatchHandler.js');
    const wrapped = createGetDispatchHandler(fakeDoc(vi.fn()), fakeDoc(vi.fn()), allowClient());
    const result = await wrapped(buildEvent(''));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 before any authorization or AWS call when dispatchId contains the pk delimiter', async () => {
    const { createGetDispatchHandler } = await import('./getDispatchHandler.js');
    const authzSend = vi.fn().mockResolvedValue({ decision: Decision.ALLOW });
    const authzClient = { send: authzSend } as unknown as VerifiedPermissionsClient;
    const dispatchesSend = vi.fn();
    const wrapped = createGetDispatchHandler(
      fakeDoc(dispatchesSend),
      fakeDoc(vi.fn()),
      authzClient,
    );
    const result = await wrapped(buildEvent('DISPATCH#1'));
    expect(result).toMatchObject({ statusCode: 400 });
    expect(authzSend).not.toHaveBeenCalled();
    expect(dispatchesSend).not.toHaveBeenCalled();
  });

  it('returns 404 when the dispatch does not exist', async () => {
    const { createGetDispatchHandler } = await import('./getDispatchHandler.js');
    const dispatchesSend = vi.fn().mockResolvedValue({ Item: undefined });
    const wrapped = createGetDispatchHandler(
      fakeDoc(dispatchesSend),
      fakeDoc(vi.fn()),
      allowClient(),
    );
    const result = await wrapped(buildEvent());
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns the enrichment from the alerting-service table only when a PRE_PLAN_COPY exists (AC1, AC3)', async () => {
    const { createGetDispatchHandler } = await import('./getDispatchHandler.js');
    const dispatchesSend = vi
      .fn()
      .mockResolvedValue({ Item: { dispatchId: 'DISPATCH-1', occupancyId: 'OCC-1' } });
    const preplanItem = {
      summary: 'Two-story residential',
      hazards: ['LPG_TANK_REAR'],
      utilityShutoffs: [{ utility: 'GAS', location: 'rear' }],
      nearestHydrants: [{ id: 'HYD-1' }],
    };
    const alertingSend = vi.fn().mockResolvedValue({ Items: [preplanItem] });
    const wrapped = createGetDispatchHandler(
      fakeDoc(dispatchesSend),
      fakeDoc(alertingSend),
      allowClient(),
    );
    const result = await wrapped(buildEvent());
    expect(result).toMatchObject({ statusCode: 200 });
    expect(dispatchesSend).toHaveBeenCalledTimes(1);
    expect(alertingSend).toHaveBeenCalledTimes(1);
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.preplan).toEqual(preplanItem);
  });

  it('omits the preplan key and returns no error when no PRE_PLAN_COPY exists (AC2)', async () => {
    const { createGetDispatchHandler } = await import('./getDispatchHandler.js');
    const dispatchesSend = vi
      .fn()
      .mockResolvedValue({ Item: { dispatchId: 'DISPATCH-1', occupancyId: 'OCC-1' } });
    const alertingSend = vi.fn().mockResolvedValue({ Items: [] });
    const wrapped = createGetDispatchHandler(
      fakeDoc(dispatchesSend),
      fakeDoc(alertingSend),
      allowClient(),
    );
    const result = await wrapped(buildEvent());
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('preplan');
  });

  it('omits the preplan key without ever reading the alerting table when the dispatch has no occupancyId (AC2)', async () => {
    const { createGetDispatchHandler } = await import('./getDispatchHandler.js');
    const dispatchesSend = vi.fn().mockResolvedValue({ Item: { dispatchId: 'DISPATCH-1' } });
    const alertingSend = vi.fn();
    const wrapped = createGetDispatchHandler(
      fakeDoc(dispatchesSend),
      fakeDoc(alertingSend),
      allowClient(),
    );
    const result = await wrapped(buildEvent());
    expect(result).toMatchObject({ statusCode: 200 });
    expect(alertingSend).not.toHaveBeenCalled();
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('preplan');
  });

  it('never invokes any client but the alerting-service dispatches/alerting tables (AC3)', async () => {
    const { createGetDispatchHandler } = await import('./getDispatchHandler.js');
    const dispatchesSend = vi
      .fn()
      .mockResolvedValue({ Item: { dispatchId: 'DISPATCH-1', occupancyId: 'OCC-1' } });
    const alertingSend = vi.fn().mockResolvedValue({ Items: [] });
    const wrapped = createGetDispatchHandler(
      fakeDoc(dispatchesSend),
      fakeDoc(alertingSend),
      allowClient(),
    );
    await wrapped(buildEvent());
    const allowedTableNames = [
      process.env.ALERTING_DISPATCHES_TABLE_NAME,
      process.env.ALERTING_TABLE_NAME,
    ];
    for (const send of [dispatchesSend, alertingSend]) {
      for (const call of send.mock.calls) {
        const input = (call[0] as { input: { TableName?: string } }).input;
        expect(allowedTableNames).toContain(input.TableName);
      }
    }
    expect(dispatchesSend).toHaveBeenCalledTimes(1);
    expect(alertingSend).toHaveBeenCalledTimes(1);
  });

  it('returns 503 when the dispatch table read fails, never a defaulted 200', async () => {
    const { createGetDispatchHandler } = await import('./getDispatchHandler.js');
    const dispatchesSend = vi.fn().mockRejectedValue(new Error('ProvisionedThroughputExceeded'));
    const wrapped = createGetDispatchHandler(
      fakeDoc(dispatchesSend),
      fakeDoc(vi.fn()),
      allowClient(),
    );
    const result = await wrapped(buildEvent());
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 503 when the pre-plan copy read fails, never a defaulted 200', async () => {
    const { createGetDispatchHandler } = await import('./getDispatchHandler.js');
    const dispatchesSend = vi
      .fn()
      .mockResolvedValue({ Item: { dispatchId: 'DISPATCH-1', occupancyId: 'OCC-1' } });
    const alertingSend = vi.fn().mockRejectedValue(new Error('ProvisionedThroughputExceeded'));
    const wrapped = createGetDispatchHandler(
      fakeDoc(dispatchesSend),
      fakeDoc(alertingSend),
      allowClient(),
    );
    const result = await wrapped(buildEvent());
    expect(result).toMatchObject({ statusCode: 503 });
  });
});
