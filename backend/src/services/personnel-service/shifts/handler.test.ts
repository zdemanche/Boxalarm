import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuardEvent } from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createFakeDocumentClient } from './testDynamoFake.js';
import { buildDutyShift, buildShiftPosition } from './testFixtures.js';

const DEPT_ID = 'NICHOLS';
const VERIFIED_DEPT_ID = toVerifiedDeptId({ deptId: DEPT_ID });
const SHIFT_ID = 'SHIFT-0511';

function buildEvent(
  overrides: {
    headers?: Record<string, string>;
    body?: string;
    pathParameters?: Record<string, string>;
  } = {},
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/personnel/shifts/{shiftId}/claim',
    rawPath: `/api/v1/personnel/shifts/${SHIFT_ID}/claim`,
    rawQueryString: '',
    headers: overrides.headers ?? { authorization: 'Bearer test-token' },
    isBase64Encoded: false,
    pathParameters: overrides.pathParameters ?? { shiftId: SHIFT_ID },
    body: overrides.body ?? JSON.stringify({ positionCode: 'DRIVER' }),
    requestContext: {
      authorizer: { lambda: { sub: 'MBR-0012', deptId: DEPT_ID, 'cognito:groups': '' } },
    } as GuardEvent['requestContext'],
  };
}

function mockAuthzDecision(decisionFn: () => Promise<{ decision: string }>): void {
  vi.doMock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
    return {
      ...actual,
      VerifiedPermissionsClient: class {
        send(): Promise<{ decision: string }> {
          return decisionFn();
        }
      },
    };
  });
}

function mockAuthzAllow(): void {
  mockAuthzDecision(() => Promise.resolve({ decision: 'ALLOW' }));
}

describe('personnel shift-claim handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PERSONNEL_TABLE_NAME = 'personnel-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unmock('@aws-sdk/client-verifiedpermissions');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('entrypoint test: the exported handler denies with 403 when no bearer token is present', async () => {
    const { handler } = await import('./handler.js');
    const result = await handler(buildEvent({ headers: {} }));
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 (fail-secure) when Verified Permissions is unavailable', async () => {
    mockAuthzDecision(() => Promise.reject(new Error('outage')));
    const { handler } = await import('./handler.js');
    const result = await handler(buildEvent());
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 403 when Verified Permissions returns an authenticated DENY decision', async () => {
    mockAuthzDecision(() => Promise.resolve({ decision: 'DENY' }));
    const { handler } = await import('./handler.js');
    const result = await handler(buildEvent());
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 400 (not a bare 5xx) when shiftId contains the pk delimiter "#"', async () => {
    mockAuthzAllow();
    const { createHandler } = await import('./handler.js');
    const claim = createHandler(createFakeDocumentClient([]));
    const result = await claim(buildEvent({ pathParameters: { shiftId: 'a#b' } }));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns a Problem Details 500 (not an unhandled rejection) when PERSONNEL_TABLE_NAME is unset', async () => {
    mockAuthzAllow();
    delete process.env.PERSONNEL_TABLE_NAME;
    const { createHandler } = await import('./handler.js');
    const claim = createHandler(createFakeDocumentClient([]));
    const result = await claim(buildEvent());
    expect(result).toMatchObject({ statusCode: 500 });
  });

  it('returns 400 when positionCode is missing from the body', async () => {
    mockAuthzAllow();
    const { createHandler } = await import('./handler.js');
    const claim = createHandler(createFakeDocumentClient([]));
    const result = await claim(buildEvent({ body: JSON.stringify({}) }));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when positionCode is an empty/whitespace string', async () => {
    mockAuthzAllow();
    const { createHandler } = await import('./handler.js');
    const claim = createHandler(createFakeDocumentClient([]));
    const result = await claim(buildEvent({ body: JSON.stringify({ positionCode: '  ' }) }));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when the body is not valid JSON', async () => {
    mockAuthzAllow();
    const { createHandler } = await import('./handler.js');
    const claim = createHandler(createFakeDocumentClient([]));
    const result = await claim(buildEvent({ body: '{not-json' }));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 404 when the shift position does not exist', async () => {
    mockAuthzAllow();
    const { createHandler } = await import('./handler.js');
    const claim = createHandler(createFakeDocumentClient([]));
    const result = await claim(buildEvent());
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 409 when the position was already claimed by another member', async () => {
    mockAuthzAllow();
    const { createHandler } = await import('./handler.js');
    const doc = createFakeDocumentClient([
      buildDutyShift(VERIFIED_DEPT_ID, SHIFT_ID),
      buildShiftPosition(VERIFIED_DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0099' }),
    ]);
    const claim = createHandler(doc);
    const result = await claim(buildEvent());
    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('AC1/AC3: succeeds with 200 and the claim body, and recalculates the DUTY_SHIFT status', async () => {
    mockAuthzAllow();
    const { createHandler } = await import('./handler.js');
    const doc = createFakeDocumentClient([
      buildDutyShift(VERIFIED_DEPT_ID, SHIFT_ID),
      buildShiftPosition(VERIFIED_DEPT_ID, SHIFT_ID, 'DRIVER'),
    ]);
    const claim = createHandler(doc);
    const result = await claim(buildEvent());
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { claimedByMemberId: string };
    expect(body.claimedByMemberId).toBe('MBR-0012');
  });

  it('returns 500 when the post-claim status recalculation throws (distinct from the write-path 503)', async () => {
    mockAuthzAllow();
    const { createHandler } = await import('./handler.js');
    const workingDoc = createFakeDocumentClient([
      buildDutyShift(VERIFIED_DEPT_ID, SHIFT_ID),
      buildShiftPosition(VERIFIED_DEPT_ID, SHIFT_ID, 'DRIVER'),
    ]);
    const send = (workingDoc as unknown as { send: (command: unknown) => Promise<unknown> }).send;
    const recalcFailingDoc = {
      send: (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        return name === 'QueryCommand'
          ? Promise.reject(new Error('recalc unavailable'))
          : send(command);
      },
    } as unknown as Parameters<typeof createHandler>[0];
    const claim = createHandler(recalcFailingDoc);
    const result = await claim(buildEvent());
    expect(result).toMatchObject({ statusCode: 500 });
  });

  it('emits a ClaimAllowed business metric on success (business-metrics obligation)', async () => {
    mockAuthzAllow();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { createHandler } = await import('./handler.js');
    const doc = createFakeDocumentClient([
      buildDutyShift(VERIFIED_DEPT_ID, SHIFT_ID),
      buildShiftPosition(VERIFIED_DEPT_ID, SHIFT_ID, 'DRIVER'),
    ]);
    const claim = createHandler(doc);
    await claim(buildEvent());
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ClaimAllowed'));
  });

  it('logs the original error, not just a swallowed message, when the write path fails', async () => {
    mockAuthzAllow();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createHandler } = await import('./handler.js');
    const failingDoc = {
      send: () => Promise.reject(new Error('DynamoDB unavailable')),
    } as unknown as Parameters<typeof createHandler>[0];
    const claim = createHandler(failingDoc);
    await claim(buildEvent());
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('personnel.shift_position.claim_failed'),
    );
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as { message?: string };
    expect(logged.message).toBe('DynamoDB unavailable');
  });
});
