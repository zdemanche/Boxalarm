import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  getCutoverDecision: vi.fn(),
}));

vi.mock('./deliveryBaseline.js', () => ({
  readDeliveryBaseline: vi.fn(),
}));

import { readDeliveryBaseline } from './deliveryBaseline.js';
import { getCutoverDecision } from './repository.js';
import { handler } from './get.js';

const principal = { sub: 'member-0001', deptId: 'NICHOLS', 'cognito:groups': 'ADMIN' };

function buildEvent(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    requestContext: { authorizer: { lambda: principal } },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cutover decision get handler', () => {
  it('wires the ViewCutoverDecision action against the Department resource', () => {
    expect(capturedOptions[0]).toMatchObject({
      actionType: 'Boxalarm::Action',
      actionId: 'ViewCutoverDecision',
      resourceType: 'Boxalarm::Department',
    });
  });

  it('resolves the Cedar resourceId to the principal deptId', () => {
    expect(capturedOptions[0]?.resourceId(buildEvent())).toBe('NICHOLS');
  });

  it('defaults retainedPagingRequired to true when no decision has been recorded (core-harm row)', async () => {
    vi.mocked(getCutoverDecision).mockResolvedValue(undefined);
    const result = (await handler(buildEvent())) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      decision: null,
      decider: null,
      decidedAt: null,
      retainedPagingRequired: true,
    });
  });

  it('reports retainedPagingRequired true when the latest decision is defer', async () => {
    vi.mocked(getCutoverDecision).mockResolvedValue({
      decision: 'defer',
      decider: 'member-0002',
      decidedAt: 1700000000000,
    });
    const result = (await handler(buildEvent())) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(
      (JSON.parse(result.body) as { retainedPagingRequired: boolean }).retainedPagingRequired,
    ).toBe(true);
  });

  it('reports retainedPagingRequired false only when the latest decision is accept', async () => {
    vi.mocked(getCutoverDecision).mockResolvedValue({
      decision: 'accept',
      decider: 'member-0002',
      decidedAt: 1700000000000,
    });
    const result = (await handler(buildEvent())) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      decision: 'accept',
      decider: 'member-0002',
      decidedAt: 1700000000000,
      retainedPagingRequired: false,
    });
  });

  it('returns 503, logs the original error, and emits a failure metric when the store is unavailable', async () => {
    const failure = new Error('table unavailable');
    vi.mocked(getCutoverDecision).mockRejectedValue(failure);
    const result = (await handler(buildEvent())) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(503);
    const body = JSON.parse(result.body) as { status: number; traceId: string };
    expect(body.status).toBe(503);
    expect(body.traceId).toBeTruthy();
    expect(logError).toHaveBeenCalledWith(
      'reporting.cutoverDecision.get_failed',
      failure,
      expect.objectContaining({ deptId: 'NICHOLS' }),
    );
    expect(emitOutcomeMetric).toHaveBeenCalledWith(
      'Boxalarm/ReportingService',
      'ReportingCutoverDecisionGetFailed',
      'Error',
    );
  });

  it('emits a business metric on success', async () => {
    vi.mocked(getCutoverDecision).mockResolvedValue(undefined);
    await handler(buildEvent());
    expect(emitOutcomeMetric).toHaveBeenCalledWith(
      'Boxalarm/ReportingService',
      'ReportingCutoverDecisionGetSucceeded',
    );
  });

  it('rejects a baseline range wider than 90 days with 400 before reading anything', async () => {
    const result = (await handler(
      buildEvent({ queryStringParameters: { from: '0', to: String(91 * 86_400) } }),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(400);
    expect(getCutoverDecision).not.toHaveBeenCalled();
    expect(readDeliveryBaseline).not.toHaveBeenCalled();
  });

  it('accepts a full 90-day inclusive range', async () => {
    vi.mocked(getCutoverDecision).mockResolvedValue(undefined);
    vi.mocked(readDeliveryBaseline).mockResolvedValue({} as never);
    const result = (await handler(
      buildEvent({ queryStringParameters: { from: '0', to: String(90 * 86_400 - 1) } }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(200);
  });

  it('still returns the decision and retained paging when the baseline lambda is rejected', async () => {
    const failure = new Error('delivery baseline lambda returned status 403');
    vi.mocked(getCutoverDecision).mockResolvedValue(undefined);
    vi.mocked(readDeliveryBaseline).mockRejectedValue(failure);
    const result = (await handler(
      buildEvent({ queryStringParameters: { from: '0', to: '86399' } }),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      decision: null,
      decider: null,
      decidedAt: null,
      retainedPagingRequired: true,
      deliveryBaselineUnavailable: true,
    });
    expect(logError).toHaveBeenCalledWith(
      'reporting.cutoverDecision.baseline_unavailable',
      failure,
      expect.objectContaining({ deptId: 'NICHOLS' }),
    );
    expect(emitOutcomeMetric).toHaveBeenCalledWith(
      'Boxalarm/ReportingService',
      'ReportingCutoverBaselineUnavailable',
      'Error',
    );
    expect(emitOutcomeMetric).not.toHaveBeenCalledWith(
      'Boxalarm/ReportingService',
      'ReportingCutoverDecisionGetFailed',
      expect.anything(),
    );
  });
});
