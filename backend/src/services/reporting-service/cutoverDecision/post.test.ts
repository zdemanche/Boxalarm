import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedOptions {
  readonly actionType: string;
  readonly actionId: string;
  readonly resourceType: string;
  readonly resourceId: (event: {
    requestContext: { authorizer?: { lambda?: { deptId?: string } } };
  }) => string;
}

const capturedOptions: CapturedOptions[] = vi.hoisted(() => []);
const { logError, emitOutcomeMetric } = vi.hoisted(() => ({
  logError: vi.fn(),
  emitOutcomeMetric: vi.fn(),
}));

vi.mock('@boxalarm/authz', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boxalarm/authz')>();
  return {
    ...actual,
    withAuthorization: (
      inner: (event: unknown, principal: unknown) => Promise<unknown>,
      options: CapturedOptions,
    ) => {
      capturedOptions.push(options);
      return async (event: { requestContext: { authorizer: { lambda: unknown } } }) =>
        inner(event, event.requestContext.authorizer.lambda);
    },
  };
});

vi.mock('../awsClients.js', () => ({
  readReportingServiceConfig: vi.fn(() => ({ tableName: 'platform-table' })),
  createDynamoDocClient: vi.fn(() => ({})),
}));

vi.mock('../logger.js', () => ({
  logError,
  logger: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@boxalarm/metrics', () => ({ emitOutcomeMetric }));

vi.mock('./repository.js', () => ({
  recordCutoverDecision: vi.fn(),
}));

import { recordCutoverDecision } from './repository.js';
import { handler } from './post.js';

const principal = { sub: 'member-0007', deptId: 'NICHOLS', 'cognito:groups': 'ADMIN' };

function buildEvent(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    body: JSON.stringify({ decision: 'accept' }),
    requestContext: { authorizer: { lambda: principal } },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(1700000000000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('cutover decision post handler', () => {
  it('wires the RecordCutoverDecision action against the Department resource', () => {
    expect(capturedOptions[0]).toMatchObject({
      actionType: 'Boxalarm::Action',
      actionId: 'RecordCutoverDecision',
      resourceType: 'Boxalarm::Department',
    });
  });

  it('resolves the Cedar resourceId to the principal deptId', () => {
    expect(capturedOptions[0]?.resourceId(buildEvent())).toBe('NICHOLS');
  });

  it('persists the decision with decider derived from the authenticated principal, never the body', async () => {
    vi.mocked(recordCutoverDecision).mockResolvedValue(undefined);
    const result = (await handler(
      buildEvent({ body: JSON.stringify({ decision: 'accept', decider: 'someone-else' }) }),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(recordCutoverDecision).toHaveBeenCalledWith(
      {},
      'platform-table',
      'NICHOLS',
      { decision: 'accept', decider: 'member-0007', decidedAt: 1700000000000 },
    );
    expect(JSON.parse(result.body)).toEqual({
      decision: 'accept',
      decider: 'member-0007',
      decidedAt: 1700000000000,
    });
  });

  it('persists a defer decision', async () => {
    vi.mocked(recordCutoverDecision).mockResolvedValue(undefined);
    await handler(buildEvent({ body: JSON.stringify({ decision: 'defer' }) }));
    expect(recordCutoverDecision).toHaveBeenCalledWith(
      {},
      'platform-table',
      'NICHOLS',
      { decision: 'defer', decider: 'member-0007', decidedAt: 1700000000000 },
    );
  });

  it('returns 400 with no DynamoDB call when decision is absent', async () => {
    const result = (await handler(buildEvent({ body: JSON.stringify({}) }))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(400);
    expect(recordCutoverDecision).not.toHaveBeenCalled();
    const body = JSON.parse(result.body) as { status: number; traceId: string };
    expect(body.status).toBe(400);
    expect(body.traceId).toBeTruthy();
  });

  it('returns 400 when decision is wrong-typed (number)', async () => {
    const result = (await handler(
      buildEvent({ body: JSON.stringify({ decision: 1 }) }),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(400);
    expect(recordCutoverDecision).not.toHaveBeenCalled();
  });

  it('returns 400 when decision is wrong-typed (object)', async () => {
    const result = (await handler(
      buildEvent({ body: JSON.stringify({ decision: { value: 'accept' } }) }),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(400);
    expect(recordCutoverDecision).not.toHaveBeenCalled();
  });

  it('returns 400 when decision is a string outside the enum', async () => {
    const result = (await handler(
      buildEvent({ body: JSON.stringify({ decision: 'maybe' }) }),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(400);
    expect(recordCutoverDecision).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON, caught before any field access', async () => {
    const result = (await handler(buildEvent({ body: '{not json' }))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(400);
    expect(recordCutoverDecision).not.toHaveBeenCalled();
  });

  it('returns 400 for an absent body', async () => {
    const result = (await handler(buildEvent({ body: undefined }))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(400);
    expect(recordCutoverDecision).not.toHaveBeenCalled();
  });

  it('returns 503, logs the original error, and emits a failure metric on transact-write failure, decision never silently dropped', async () => {
    const failure = new Error('transact-write throttled');
    vi.mocked(recordCutoverDecision).mockRejectedValue(failure);
    const result = (await handler(buildEvent())) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(503);
    const body = JSON.parse(result.body) as { status: number; traceId: string };
    expect(body.status).toBe(503);
    expect(body.traceId).toBeTruthy();
    expect(logError).toHaveBeenCalledWith(
      'reporting.cutoverDecision.post_failed',
      failure,
      expect.objectContaining({ deptId: 'NICHOLS', decision: 'accept' }),
    );
    expect(emitOutcomeMetric).toHaveBeenCalledWith(
      'Boxalarm/ReportingService',
      'ReportingCutoverDecisionPostFailed',
      'Error',
    );
  });

  it('emits a business metric on success', async () => {
    vi.mocked(recordCutoverDecision).mockResolvedValue(undefined);
    await handler(buildEvent());
    expect(emitOutcomeMetric).toHaveBeenCalledWith(
      'Boxalarm/ReportingService',
      'ReportingCutoverDecisionPostSucceeded',
    );
  });
});
