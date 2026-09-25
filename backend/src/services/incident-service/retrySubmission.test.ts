import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentEvent } from './authContext.js';

function buildEvent(
  lambdaContext: Record<string, unknown> | undefined,
  incidentId: string | undefined,
  headers: Record<string, string> = {},
): IncidentEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/incidents/{incidentId}/submission/retry',
    rawPath: `/api/v1/incidents/${incidentId ?? ''}/submission/retry`,
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
        method: 'POST',
        path: `/api/v1/incidents/${incidentId ?? ''}/submission/retry`,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'POST /api/v1/incidents/{incidentId}/submission/retry',
      stage: '$default',
      time: '',
      timeEpoch: 0,
      authorizer: lambdaContext !== undefined ? { lambda: lambdaContext } : undefined,
    },
  } as unknown as IncidentEvent;
}

const ADMIN_AUTH = { sub: 'MBR-0034', deptId: 'NICHOLS', 'cognito:groups': 'ADMIN' };
const CHIEF_AUTH = { sub: 'MBR-0001', deptId: 'NICHOLS', 'cognito:groups': 'CHIEF' };
const OFFICER_AUTH = { sub: 'MBR-0002', deptId: 'NICHOLS', 'cognito:groups': 'OFFICER' };
const MEMBER_AUTH = { sub: 'MBR-0099', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' };
const INCIDENT_ID = 'NICHOLS-4471-1798000000';

describe('retrySubmission handler', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unmock('./submissionRepository.js');
    vi.restoreAllMocks();
  });

  it('returns 401 when the authorizer context is missing', async () => {
    const { handler } = await import('./retrySubmission.js');

    const result = await handler(buildEvent(undefined, INCIDENT_ID), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 403 for a member who is not an officer or admin', async () => {
    const { handler } = await import('./retrySubmission.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, INCIDENT_ID),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 400 when incidentId path parameter is absent', async () => {
    const { handler } = await import('./retrySubmission.js');

    const result = await handler(buildEvent(ADMIN_AUTH, undefined), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when incidentId contains the pk delimiter', async () => {
    const { handler } = await import('./retrySubmission.js');

    const result = await handler(buildEvent(ADMIN_AUTH, 'bad#id'), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 202 and enqueues a retry when submissionStatus is FAILED (AC2)', async () => {
    const retrySubmission = vi.fn().mockResolvedValue({ submissionStatus: 'RETRYING' });
    vi.doMock('./submissionRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./submissionRepository.js')>();
      return { ...actual, getSubmissionRepository: () => ({ retrySubmission }) };
    });
    const { handler } = await import('./retrySubmission.js');

    const result = await handler(
      buildEvent(OFFICER_AUTH, INCIDENT_ID),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 202 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).toEqual({ incidentId: INCIDENT_ID, submissionStatus: 'RETRYING' });
    expect(retrySubmission).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      expect.any(Number),
      expect.any(String),
    );
  });

  it('lets a chief retry a failed submission', async () => {
    const retrySubmission = vi.fn().mockResolvedValue({ submissionStatus: 'RETRYING' });
    vi.doMock('./submissionRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./submissionRepository.js')>();
      return { ...actual, getSubmissionRepository: () => ({ retrySubmission }) };
    });
    const { handler } = await import('./retrySubmission.js');

    const result = await handler(buildEvent(CHIEF_AUTH, INCIDENT_ID), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 202 });
  });

  it('returns 404 when the incident is missing', async () => {
    vi.doMock('./submissionRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./submissionRepository.js')>();
      const { IncidentNotFoundError } = await import('./repository.js');
      return {
        ...actual,
        getSubmissionRepository: () => ({
          retrySubmission: () => Promise.reject(new IncidentNotFoundError(INCIDENT_ID)),
        }),
      };
    });
    const { handler } = await import('./retrySubmission.js');

    const result = await handler(buildEvent(ADMIN_AUTH, INCIDENT_ID), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 409 when the submission is not FAILED', async () => {
    vi.doMock('./submissionRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./submissionRepository.js')>();
      return {
        ...actual,
        getSubmissionRepository: () => ({
          retrySubmission: () =>
            Promise.reject(new actual.SubmissionRetryConflictError(INCIDENT_ID, 'SUBMITTED')),
        }),
      };
    });
    const { handler } = await import('./retrySubmission.js');

    const result = await handler(buildEvent(ADMIN_AUTH, INCIDENT_ID), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('returns 503 problem+json on an unexpected repository failure', async () => {
    vi.doMock('./submissionRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./submissionRepository.js')>();
      return {
        ...actual,
        getSubmissionRepository: () => ({
          retrySubmission: () => Promise.reject(new Error('DynamoDB unavailable')),
        }),
      };
    });
    const { handler } = await import('./retrySubmission.js');

    const result = await handler(buildEvent(ADMIN_AUTH, INCIDENT_ID), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 503 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.type).toBe('about:blank');
    expect(body.traceId).toBeDefined();
  });
});
