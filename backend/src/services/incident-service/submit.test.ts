import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentEvent } from './authContext.js';
import { bearerFor, fakeCedarDecision } from './testEvents.js';

const vpSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
  return {
    ...actual,
    VerifiedPermissionsClient: vi.fn(function () {
      return { send: vpSend };
    }),
  };
});

function buildEvent(
  lambdaContext: Record<string, unknown> | undefined,
  incidentId: string | undefined,
  headers: Record<string, string> = {},
): IncidentEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/incidents/{incidentId}/submit',
    rawPath: `/api/v1/incidents/${incidentId ?? ''}/submit`,
    rawQueryString: '',
    headers: { ...bearerFor(lambdaContext), ...headers },
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
        path: `/api/v1/incidents/${incidentId ?? ''}/submit`,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'POST /api/v1/incidents/{incidentId}/submit',
      stage: '$default',
      time: '',
      timeEpoch: 0,
      authorizer: lambdaContext !== undefined ? { lambda: lambdaContext } : undefined,
    },
  } as unknown as IncidentEvent;
}

const ADMIN_AUTH = { sub: 'MBR-0034', deptId: 'NICHOLS', 'cognito:groups': 'ADMIN' };
const MEMBER_AUTH = { sub: 'MBR-0099', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' };
const INCIDENT_ID = 'NICHOLS-4471-1798000000';

function mockSettings(overrides: Record<string, unknown>): void {
  vi.doMock('./nerisSettings.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./nerisSettings.js')>();
    return {
      ...actual,
      getNerisDeptSettings: () =>
        Promise.resolve({
          ...actual.DEFAULT_NERIS_SETTINGS,
          departmentNerisId: 'FD09190828',
          ...overrides,
        }),
    };
  });
}

describe('submit handler', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    vpSend.mockImplementation(fakeCedarDecision);
    vi.stubEnv('INCIDENT_TABLE_NAME', 'incident-table');
    mockSettings({});
  });

  afterEach(() => {
    vi.doUnmock('./submissionRepository.js');
    vi.doUnmock('./nerisSettings.js');
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns 401 when the authorizer context is missing', async () => {
    const { handler } = await import('./submit.js');

    const result = await handler(buildEvent(undefined, INCIDENT_ID));

    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 403 for a non-admin caller', async () => {
    const { handler } = await import('./submit.js');

    const result = await handler(buildEvent(MEMBER_AUTH, INCIDENT_ID));

    expect(result).toMatchObject({ statusCode: 403 });
  });

  // Security-web MINOR 2: submit is Cedar SubmitIncidentReport, the NERIS officer tier - the
  // officer who may resubmit a report may also submit it.
  it('lets an officer submit, decided by Cedar SubmitIncidentReport on the incident', async () => {
    const enqueueSubmission = vi.fn().mockResolvedValue({ submissionStatus: 'SUBMITTED' });
    vi.doMock('./submissionRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./submissionRepository.js')>();
      return { ...actual, getSubmissionRepository: () => ({ enqueueSubmission }) };
    });
    const { handler } = await import('./submit.js');

    const result = await handler(
      buildEvent(
        { sub: 'MBR-0001', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER OFFICER' },
        INCIDENT_ID,
      ),
    );

    expect(result).toMatchObject({ statusCode: 202 });
    expect(vpSend.mock.calls[0]?.[0]).toMatchObject({
      input: {
        action: { actionType: 'Boxalarm::Action', actionId: 'SubmitIncidentReport' },
        resource: { entityType: 'Boxalarm::Incident', entityId: INCIDENT_ID },
      },
    });
  });

  it('returns 400 when incidentId path parameter is absent', async () => {
    const { handler } = await import('./submit.js');

    const result = await handler(buildEvent(ADMIN_AUTH, undefined));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when incidentId contains the pk delimiter', async () => {
    const { handler } = await import('./submit.js');

    const result = await handler(buildEvent(ADMIN_AUTH, 'bad#id'));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 202 with submissionStatus SUBMITTED on success (AC1)', async () => {
    const enqueueSubmission = vi.fn().mockResolvedValue({ submissionStatus: 'SUBMITTED' });
    vi.doMock('./submissionRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./submissionRepository.js')>();
      return { ...actual, getSubmissionRepository: () => ({ enqueueSubmission }) };
    });
    const { handler } = await import('./submit.js');

    const result = await handler(buildEvent(ADMIN_AUTH, INCIDENT_ID));

    expect(result).toMatchObject({ statusCode: 202 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).toEqual({ incidentId: INCIDENT_ID, submissionStatus: 'SUBMITTED' });
    expect(enqueueSubmission).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      expect.any(Number),
      expect.any(String),
    );
  });

  it('returns 404 when the incident does not exist', async () => {
    vi.doMock('./submissionRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./submissionRepository.js')>();
      const { IncidentNotFoundError } = await import('./repository.js');
      return {
        ...actual,
        getSubmissionRepository: () => ({
          enqueueSubmission: () => Promise.reject(new IncidentNotFoundError(INCIDENT_ID)),
        }),
      };
    });
    const { handler } = await import('./submit.js');

    const result = await handler(buildEvent(ADMIN_AUTH, INCIDENT_ID));

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 409 when the incident is not VALIDATED', async () => {
    vi.doMock('./submissionRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./submissionRepository.js')>();
      return {
        ...actual,
        getSubmissionRepository: () => ({
          enqueueSubmission: () =>
            Promise.reject(new actual.SubmissionConflictError(INCIDENT_ID, 'DRAFT')),
        }),
      };
    });
    const { handler } = await import('./submit.js');

    const result = await handler(buildEvent(ADMIN_AUTH, INCIDENT_ID));

    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('returns 503 problem+json on an unexpected repository failure', async () => {
    vi.doMock('./submissionRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./submissionRepository.js')>();
      return {
        ...actual,
        getSubmissionRepository: () => ({
          enqueueSubmission: () => Promise.reject(new Error('DynamoDB unavailable')),
        }),
      };
    });
    const { handler } = await import('./submit.js');

    const result = await handler(buildEvent(ADMIN_AUTH, INCIDENT_ID));

    expect(result).toMatchObject({ statusCode: 503 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.type).toBe('about:blank');
    expect(body.traceId).toBeDefined();
  });
  it('refuses with 409 SUBMISSIONS_DISABLED, without queuing, when the kill switch is off', async () => {
    mockSettings({ submissionsEnabled: false });
    const repoCall = vi.fn();
    vi.doMock('./submissionRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./submissionRepository.js')>();
      return { ...actual, getSubmissionRepository: () => ({ enqueueSubmission: repoCall }) };
    });
    const { handler } = await import('./submit.js');

    const result = await handler(buildEvent(ADMIN_AUTH, INCIDENT_ID));

    expect(result).toMatchObject({ statusCode: 409 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.code).toBe('SUBMISSIONS_DISABLED');
    expect(repoCall).not.toHaveBeenCalled();
  });

  it('refuses with 409 NOT_CONFIGURED when the department has no NERIS id', async () => {
    mockSettings({ departmentNerisId: undefined });
    const { handler } = await import('./submit.js');

    const result = await handler(buildEvent(ADMIN_AUTH, INCIDENT_ID));

    expect(result).toMatchObject({ statusCode: 409 });
    expect(JSON.parse((result as { body: string }).body)).toMatchObject({ code: 'NOT_CONFIGURED' });
  });
});
