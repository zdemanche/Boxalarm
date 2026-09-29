import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentEvent } from './authContext.js';

function buildEvent(
  lambdaContext: Record<string, unknown> | undefined,
  incidentId: string | undefined,
  headers: Record<string, string> = {},
): IncidentEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/incidents/{incidentId}/submission',
    rawPath: `/api/v1/incidents/${incidentId ?? ''}/submission`,
    rawQueryString: '',
    headers,
    isBase64Encoded: false,
    body: undefined,
    pathParameters: incidentId !== undefined ? { incidentId } : undefined,
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'GET',
        path: `/api/v1/incidents/${incidentId ?? ''}/submission`,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'GET /api/v1/incidents/{incidentId}/submission',
      stage: '$default',
      time: '',
      timeEpoch: 0,
      authorizer: lambdaContext !== undefined ? { lambda: lambdaContext } : undefined,
    },
  } as unknown as IncidentEvent;
}

const ADMIN_AUTH = { sub: 'MBR-0034', deptId: 'NICHOLS', 'cognito:groups': 'ADMIN' };
const OFFICER_AUTH = { sub: 'MBR-0002', deptId: 'NICHOLS', 'cognito:groups': 'OFFICER' };
const MEMBER_AUTH = { sub: 'MBR-0099', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' };
const INCIDENT_ID = 'NICHOLS-4471-1798000000';

describe('getSubmission handler', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.INCIDENT_TABLE_NAME = 'incident-table';
  });

  afterEach(() => {
    vi.unmock('./submissionRepository.js');
    vi.unmock('./reviewRepository.js');
    vi.restoreAllMocks();
  });

  it('returns 401 when the authorizer context is missing', async () => {
    const { handler } = await import('./getSubmission.js');

    const result = await handler(buildEvent(undefined, INCIDENT_ID), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 403 for a member who is not an officer or admin', async () => {
    const { handler } = await import('./getSubmission.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, INCIDENT_ID),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 400 when incidentId path parameter is absent', async () => {
    const { handler } = await import('./getSubmission.js');

    const result = await handler(buildEvent(ADMIN_AUTH, undefined), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when incidentId contains the pk delimiter', async () => {
    const { handler } = await import('./getSubmission.js');

    const result = await handler(buildEvent(ADMIN_AUTH, 'bad#id'), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 400 });
  });

  function mockLedger(ledger = { attempts: [], statusHistory: [] }) {
    vi.doMock('./reviewRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./reviewRepository.js')>();
      return { ...actual, querySubmissionLedger: () => Promise.resolve(ledger) };
    });
  }

  const EMPTY_LEDGER_FIELDS = {
    nerisIncidentId: null,
    nerisStatus: null,
    nerisStatusAt: null,
    lockedAt: null,
    lockedBy: null,
    payloadHash: null,
    firstSubmittedAt: null,
    editedSinceSubmission: false,
    attempts: [],
    statusHistory: [],
  };

  it('returns the full submission ledger: attempts, NERIS id and status history', async () => {
    const attempts = [
      {
        attempt: 1,
        attemptedAt: '2026-09-29T10:00:00.000Z',
        outcome: 'VALIDATION_ERROR',
        httpStatus: 422,
        retryCount: 0,
        errors: [{ path: 'dispatch.call_create', code: 'missing', message: 'Field required' }],
      },
      {
        attempt: 2,
        attemptedAt: '2026-09-29T11:00:00.000Z',
        outcome: 'SUCCESS',
        httpStatus: 201,
        retryCount: 0,
        operation: 'CREATE',
        nerisIncidentId: 'FD09190828|4471|1798000000',
        payloadHash: 'abc',
        errors: [],
      },
    ];
    const statusHistory = [
      { status: 'SUBMITTED', at: '2026-09-29T11:00:00Z', current: false },
      { status: 'REJECTED', at: '2026-09-30T09:00:00Z', current: true },
    ];
    mockLedger({ attempts, statusHistory } as never);
    vi.doMock('./submissionRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./submissionRepository.js')>();
      return {
        ...actual,
        getSubmissionRepository: () => ({
          getSubmission: () =>
            Promise.resolve({
              incidentId: INCIDENT_ID,
              status: 'REJECTED',
              submissionStatus: 'ACCEPTED',
              nerisIncidentId: 'FD09190828|4471|1798000000',
              nerisStatus: 'REJECTED',
              nerisStatusAt: 1_798_090_000,
              lockedAt: 1_798_003_000,
              lockedBy: 'MBR-0034',
              lastPayloadHash: 'abc',
              firstSubmittedAt: 1_798_003_600,
              lastSubmittedAt: 1_798_003_600,
              updatedAt: 1_798_095_000,
            }),
        }),
      };
    });
    const { handler } = await import('./getSubmission.js');

    const result = await handler(
      buildEvent(OFFICER_AUTH, INCIDENT_ID),
      {} as never,
      () => undefined,
    );

    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).toMatchObject({
      nerisIncidentId: 'FD09190828|4471|1798000000',
      nerisStatus: 'REJECTED',
      payloadHash: 'abc',
      editedSinceSubmission: true,
      attempts,
      statusHistory,
    });
  });

  it('returns 200 with submissionStatus and the failure reason when FAILED, read for the caller dept (AC4)', async () => {
    mockLedger();
    const getSubmission = vi.fn().mockResolvedValue({
      incidentId: INCIDENT_ID,
      status: 'REJECTED',
      submissionStatus: 'FAILED',
      submissionFailureReason: 'NERIS rejected the submission with HTTP 400',
    });
    vi.doMock('./submissionRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./submissionRepository.js')>();
      return { ...actual, getSubmissionRepository: () => ({ getSubmission }) };
    });
    const { handler } = await import('./getSubmission.js');

    const result = await handler(buildEvent(ADMIN_AUTH, INCIDENT_ID), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).toEqual({
      incidentId: INCIDENT_ID,
      status: 'REJECTED',
      submissionStatus: 'FAILED',
      submissionFailureReason: 'NERIS rejected the submission with HTTP 400',
      ...EMPTY_LEDGER_FIELDS,
    });
    expect(getSubmission).toHaveBeenCalledWith('NICHOLS', INCIDENT_ID);
  });

  it('lets an officer read submission status', async () => {
    mockLedger();
    const getSubmission = vi.fn().mockResolvedValue({
      incidentId: INCIDENT_ID,
      status: 'SUBMITTED',
      submissionStatus: 'RETRYING',
    });
    vi.doMock('./submissionRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./submissionRepository.js')>();
      return { ...actual, getSubmissionRepository: () => ({ getSubmission }) };
    });
    const { handler } = await import('./getSubmission.js');

    const result = await handler(
      buildEvent(OFFICER_AUTH, INCIDENT_ID),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).toEqual({
      incidentId: INCIDENT_ID,
      status: 'SUBMITTED',
      submissionStatus: 'RETRYING',
      ...EMPTY_LEDGER_FIELDS,
    });
  });

  it('returns 404 when the incident is not in the caller dept', async () => {
    vi.doMock('./submissionRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./submissionRepository.js')>();
      return {
        ...actual,
        getSubmissionRepository: () => ({
          getSubmission: () => Promise.resolve(undefined),
        }),
      };
    });
    const { handler } = await import('./getSubmission.js');

    const result = await handler(buildEvent(ADMIN_AUTH, INCIDENT_ID), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 503 problem+json on an unexpected repository failure', async () => {
    vi.doMock('./submissionRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./submissionRepository.js')>();
      return {
        ...actual,
        getSubmissionRepository: () => ({
          getSubmission: () => Promise.reject(new Error('DynamoDB unavailable')),
        }),
      };
    });
    const { handler } = await import('./getSubmission.js');

    const result = await handler(buildEvent(ADMIN_AUTH, INCIDENT_ID), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 503 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.type).toBe('about:blank');
    expect(body.traceId).toBeDefined();
  });
});
