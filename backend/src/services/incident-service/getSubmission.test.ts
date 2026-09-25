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
  });

  afterEach(() => {
    vi.unmock('./submissionRepository.js');
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

  it('returns 200 with submissionStatus and the failure reason when FAILED, read for the caller dept (AC4)', async () => {
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
    });
    expect(getSubmission).toHaveBeenCalledWith('NICHOLS', INCIDENT_ID);
  });

  it('lets an officer read submission status', async () => {
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
