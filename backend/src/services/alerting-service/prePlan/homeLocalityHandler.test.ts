import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent } from '@boxalarm/authz';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.ALERTING_TABLE_NAME = 'alerting-table';
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'store-1';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function event(): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/alerting/home-locality',
    rawPath: '/api/v1/alerting/home-locality',
    rawQueryString: '',
    headers: { authorization: 'Bearer token-1' },
    requestContext: {
      authorizer: { lambda: { sub: 'm-1', deptId: 'NICHOLS', 'cognito:groups': 'OFFICER' } },
    },
  } as unknown as GuardEvent;
}

const allow = {
  send: vi.fn().mockResolvedValue({ decision: Decision.ALLOW }),
} as unknown as VerifiedPermissionsClient;

describe('GET /api/v1/alerting/home-locality', () => {
  it('returns the configured home towns as written, for the manual-entry locality choice', async () => {
    const { createHomeLocalityHandler } = await import('./homeLocalityHandler.js');
    const docClient = {
      send: vi.fn().mockResolvedValue({
        Item: { towns: ['Trumbull', 'Long Hill'], zips: ['06611'], state: 'CT' },
      }),
    } as unknown as DynamoDBDocumentClient;

    const result = (await createHomeLocalityHandler({ authzClient: allow, docClient })(
      event(),
    )) as {
      statusCode: number;
      headers: Record<string, string>;
      body: string;
    };

    expect(result.statusCode).toBe(200);
    // Authenticated, per-department data: never stored by a shared cache.
    expect(result.headers).toMatchObject({ 'cache-control': 'private, max-age=300' });
    expect(JSON.parse(result.body)).toEqual({
      towns: ['Trumbull', 'Long Hill'],
      zips: ['06611'],
      state: 'CT',
    });
  });

  it('degrades to an empty list (the form then offers only "Other town"), never an error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { createHomeLocalityHandler } = await import('./homeLocalityHandler.js');
    const docClient = {
      send: vi.fn().mockRejectedValue(new Error('throttled')),
    } as unknown as DynamoDBDocumentClient;

    const result = (await createHomeLocalityHandler({ authzClient: allow, docClient })(
      event(),
    )) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ towns: [], zips: [], state: null });
    // m7: a form load is counted apart from the alarmed dispatch-detail HomeLocalityMissing.
    const metrics = logSpy.mock.calls.join('\n');
    expect(metrics).toContain('HomeLocalityFormMissing');
    expect(metrics).not.toMatch(/"HomeLocalityMissing"/);
    logSpy.mockRestore();
  });

  it('is 403 on a Cedar deny', async () => {
    const { createHomeLocalityHandler } = await import('./homeLocalityHandler.js');
    const deny = {
      send: vi.fn().mockResolvedValue({ decision: Decision.DENY }),
    } as unknown as VerifiedPermissionsClient;
    const result = await createHomeLocalityHandler({ authzClient: deny })(event());
    expect(result).toMatchObject({ statusCode: 403 });
  });
});
