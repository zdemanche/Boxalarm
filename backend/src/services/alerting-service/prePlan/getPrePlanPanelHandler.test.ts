import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent } from '@boxalarm/authz';

const PRINCIPAL = { sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': 'member' };

function buildEvent(
  occupancyId = 'OCC-1',
  headers: Record<string, string> = { authorization: 'Bearer token' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/alerting/occupancies/{occupancyId}/pre-plan',
    rawPath: `/api/v1/alerting/occupancies/${occupancyId}/pre-plan`,
    rawQueryString: '',
    headers,
    pathParameters: { occupancyId },
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

describe('getPrePlanPanelHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 401 (fail-closed) on a missing bearer token via the real exported handler, before any AWS call (entrypoint test)', async () => {
    const { handler } = await import('./getPrePlanPanelHandler.js');
    const result = await handler(buildEvent('OCC-1', {}));
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 403 on a Cedar deny', async () => {
    const { createGetPrePlanPanelHandler } = await import('./getPrePlanPanelHandler.js');
    const denyClient = {
      send: vi.fn().mockResolvedValue({ decision: Decision.DENY }),
    } as unknown as VerifiedPermissionsClient;
    const wrapped = createGetPrePlanPanelHandler(fakeDoc(vi.fn()), denyClient);
    const result = await wrapped(buildEvent());
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 when Verified Permissions is unavailable', async () => {
    const { createGetPrePlanPanelHandler } = await import('./getPrePlanPanelHandler.js');
    const unavailableClient = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    const wrapped = createGetPrePlanPanelHandler(fakeDoc(vi.fn()), unavailableClient);
    const result = await wrapped(buildEvent());
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns the panel from a single GetCommand against PRE_PLAN_COPY, hydrants verbatim (AC1/AC2)', async () => {
    const { createGetPrePlanPanelHandler } = await import('./getPrePlanPanelHandler.js');
    const item = {
      summary: 'Two-story residential, rear LPG tank',
      hazards: ['LPG_TANK_REAR'],
      utilityShutoffs: [{ utility: 'gas', location: 'rear yard' }],
      nearestHydrants: [
        { hydrantId: 'HYD-1', latitude: 41.24, longitude: -73.2, size: '6in', flowRatingGpm: 1000 },
      ],
    };
    const send = vi.fn().mockResolvedValue({ Item: item });
    const wrapped = createGetPrePlanPanelHandler(fakeDoc(send), allowClient());
    const result = await wrapped(buildEvent());
    expect(result).toMatchObject({ statusCode: 200 });
    expect(send).toHaveBeenCalledTimes(1);
    const sentCommand = send.mock.calls[0]?.[0] as { input: { Key: { pk: string; sk: string } } };
    expect(sentCommand.input.Key).toEqual({ pk: 'DEPT#NICHOLS#PREPLAN', sk: 'OCCUPANCY#OCC-1' });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.summary).toBe(item.summary);
    expect(body.hazards).toEqual(item.hazards);
    expect(body.utilityShutoffs).toEqual(item.utilityShutoffs);
    expect(body.nearestHydrants).toEqual(item.nearestHydrants);
  });

  it('returns 404 with a clear no-pre-plan-on-file detail when no item is found (AC3)', async () => {
    const { createGetPrePlanPanelHandler } = await import('./getPrePlanPanelHandler.js');
    const send = vi.fn().mockResolvedValue({});
    const wrapped = createGetPrePlanPanelHandler(fakeDoc(send), allowClient());
    const result = await wrapped(buildEvent());
    expect(result).toMatchObject({ statusCode: 404 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.detail).toMatch(/no pre-plan is on file/i);
  });

  it('returns 404 with no crash when occupancyId path param is empty', async () => {
    const { createGetPrePlanPanelHandler } = await import('./getPrePlanPanelHandler.js');
    const send = vi.fn().mockResolvedValue({});
    const wrapped = createGetPrePlanPanelHandler(fakeDoc(send), allowClient());
    const result = await wrapped(buildEvent(''));
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 503 fail-closed when DynamoDB is unavailable, logging the original error first', async () => {
    const loggerModule = await import('../logger.js');
    const logErrorSpy = vi.spyOn(loggerModule, 'logError').mockImplementation(() => {});
    const { createGetPrePlanPanelHandler } = await import('./getPrePlanPanelHandler.js');
    const send = vi.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
    const wrapped = createGetPrePlanPanelHandler(fakeDoc(send), allowClient());
    const result = await wrapped(buildEvent());
    expect(result).toMatchObject({ statusCode: 503 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.type).toBe('https://boxalarm.dev/problems/dependency-unavailable');
    expect(body.detail).toBe('A required upstream dependency is temporarily unavailable.');
    expect(logErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'preplan_panel.dependency_failed',
        message: 'ProvisionedThroughputExceededException',
      }),
    );
  });
});
