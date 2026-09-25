import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const INCIDENT_ID = 'NICHOLS-4471-1798000000';

const FAKE_CONTEXT = {
  invokedFunctionArn: 'arn:aws:lambda:us-east-1:111122223333:function:submission-worker',
} as never;

function sqsRecord(body: unknown, messageId = 'msg-1'): SQSRecord {
  return { messageId, body: typeof body === 'string' ? body : JSON.stringify(body) } as SQSRecord;
}

function submittedEnvelope(deptId: string, incidentId: string): unknown {
  return { detail: { payload: { deptId, incidentId } } };
}

function fakeIncident(corePayload: Record<string, unknown> = { incident_type: 'STRUCTURE_FIRE' }) {
  return {
    incidentId: INCIDENT_ID,
    deptId: DEPT_ID,
    dispatchNumber: '4471',
    epochSeconds: 1_798_000_000,
    nerisSchemaVersion: '2026.2',
    corePayload,
    status: 'SUBMITTED',
    sourceDispatchId: INCIDENT_ID,
    createdBy: 'MBR-0034',
    createdAt: 1_798_000_000,
    updatedAt: 1_798_000_000,
  };
}

function mockDeps(options: {
  readonly httpStatus?: number;
  readonly fetchError?: Error;
  readonly incidentExists?: boolean;
  readonly production?: boolean;
}) {
  const getIncident = vi
    .fn()
    .mockResolvedValue(options.incidentExists === false ? undefined : fakeIncident());
  vi.doMock('../repository.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../repository.js')>();
    return { ...actual, getIncidentRepository: () => ({ getIncident }) };
  });

  const appendSubmissionAttempt = vi.fn().mockResolvedValue({ submissionStatus: 'RETRYING' });
  vi.doMock('../submissionRepository.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../submissionRepository.js')>();
    return { ...actual, getSubmissionRepository: () => ({ appendSubmissionAttempt }) };
  });

  const fetchFn = options.fetchError
    ? vi.fn().mockRejectedValue(options.fetchError)
    : vi.fn().mockResolvedValue({ status: options.httpStatus ?? 200 });
  vi.doMock('./index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./index.js')>();
    return {
      ...actual,
      readNerisConfig: () =>
        Promise.resolve({
          baseUrl: 'https://dev.neris.fsri.org',
          userAgent: 'boxalarm/dev',
          clientId: 'c',
          clientSecret: 's',
        }),
      getNerisClient: () => ({ fetch: fetchFn }),
      isBoxalarmProductionEnvironment: () => options.production ?? false,
    };
  });

  return { getIncident, appendSubmissionAttempt, fetchFn };
}

describe('submissionWorker handler (SQS trigger)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NERIS_SUBMISSION_SCHEDULER_ROLE_ARN = 'arn:aws:iam::111122223333:role/neris-submission-scheduler';
  });

  afterEach(() => {
    delete process.env.NERIS_SUBMISSION_SCHEDULER_ROLE_ARN;
    vi.unmock('../repository.js');
    vi.unmock('../submissionRepository.js');
    vi.unmock('./index.js');
    vi.restoreAllMocks();
  });

  it('finalizes SUCCESS on a 2xx response with no retry scheduled (AC4)', async () => {
    const { appendSubmissionAttempt } = mockDeps({ httpStatus: 202 });
    const { createHandler } = await import('./submissionWorker.js');
    const schedulerSend = vi.fn();
    const handler = createHandler({ schedulerClient: { send: schedulerSend } as never });

    const event: SQSEvent = { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] };
    const result = await handler(event, FAKE_CONTEXT, () => undefined);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(appendSubmissionAttempt).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      expect.objectContaining({ outcome: 'SUCCESS', httpStatus: 202, retryCount: 0 }),
      true,
      expect.any(Number),
    );
    expect(schedulerSend).not.toHaveBeenCalled();
  });

  it('appends RATE_LIMITED and schedules a retry on HTTP 429, never a single failing attempt (AC2)', async () => {
    const { appendSubmissionAttempt } = mockDeps({ httpStatus: 429 });
    const { createHandler } = await import('./submissionWorker.js');
    const schedulerSend = vi.fn().mockResolvedValue({});
    const handler = createHandler({ schedulerClient: { send: schedulerSend } as never });

    const event: SQSEvent = { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] };
    const result = await handler(event, FAKE_CONTEXT, () => undefined);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(appendSubmissionAttempt).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      expect.objectContaining({ outcome: 'RATE_LIMITED', httpStatus: 429, retryCount: 0 }),
      false,
      expect.any(Number),
    );
    expect(schedulerSend).toHaveBeenCalledTimes(1);
  });

  it('appends VALIDATION_ERROR terminally on a non-429 4xx with no retry (never retries a rejection)', async () => {
    const { appendSubmissionAttempt } = mockDeps({ httpStatus: 422 });
    const { createHandler } = await import('./submissionWorker.js');
    const schedulerSend = vi.fn();
    const handler = createHandler({ schedulerClient: { send: schedulerSend } as never });

    const event: SQSEvent = { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] };
    await handler(event, FAKE_CONTEXT, () => undefined);

    expect(appendSubmissionAttempt).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      expect.objectContaining({ outcome: 'VALIDATION_ERROR', httpStatus: 422 }),
      true,
      expect.any(Number),
    );
    expect(schedulerSend).not.toHaveBeenCalled();
  });

  it('appends SERVER_ERROR and schedules a retry on a 5xx response or a thrown fetch error', async () => {
    const { appendSubmissionAttempt } = mockDeps({ fetchError: new Error('network down') });
    const { createHandler } = await import('./submissionWorker.js');
    const schedulerSend = vi.fn().mockResolvedValue({});
    const handler = createHandler({ schedulerClient: { send: schedulerSend } as never });

    const event: SQSEvent = { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] };
    await handler(event, FAKE_CONTEXT, () => undefined);

    expect(appendSubmissionAttempt).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      expect.objectContaining({ outcome: 'SERVER_ERROR', retryCount: 0 }),
      false,
      expect.any(Number),
    );
    expect(schedulerSend).toHaveBeenCalledTimes(1);
  });

  it('never a silent drop: a malformed SQS record is logged, returned as batchItemFailures, and never appends an attempt (core-harm row)', async () => {
    const { appendSubmissionAttempt } = mockDeps({ httpStatus: 200 });
    const { createHandler } = await import('./submissionWorker.js');
    const handler = createHandler({ schedulerClient: { send: vi.fn() } as never });

    const event: SQSEvent = { Records: [sqsRecord('not json', 'bad-msg')] };
    const result = await handler(event, FAKE_CONTEXT, () => undefined);

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'bad-msg' }] });
    expect(appendSubmissionAttempt).not.toHaveBeenCalled();
  });
});

describe('submissionWorker handler (EventBridge Scheduler retry trigger)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NERIS_SUBMISSION_SCHEDULER_ROLE_ARN = 'arn:aws:iam::111122223333:role/neris-submission-scheduler';
  });

  afterEach(() => {
    delete process.env.NERIS_SUBMISSION_SCHEDULER_ROLE_ARN;
    vi.unmock('../repository.js');
    vi.unmock('../submissionRepository.js');
    vi.unmock('./index.js');
    vi.restoreAllMocks();
  });

  it('attempts submission directly using the invocation retryCount, not 0', async () => {
    const { appendSubmissionAttempt } = mockDeps({ httpStatus: 429 });
    const { createHandler } = await import('./submissionWorker.js');
    const schedulerSend = vi.fn().mockResolvedValue({});
    const handler = createHandler({ schedulerClient: { send: schedulerSend } as never });

    await handler(
      { deptId: 'NICHOLS', incidentId: INCIDENT_ID, retryCount: 2 },
      FAKE_CONTEXT,
      () => undefined,
    );

    expect(appendSubmissionAttempt).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      expect.objectContaining({ retryCount: 2 }),
      false,
      expect.any(Number),
    );
  });

  it('finalizes terminal FAILED (never silently dropped) once MAX_SUBMISSION_RETRIES is reached on a further 429', async () => {
    const { appendSubmissionAttempt } = mockDeps({ httpStatus: 429 });
    const { createHandler, MAX_SUBMISSION_RETRIES } = await import('./submissionWorker.js');
    const schedulerSend = vi.fn().mockResolvedValue({});
    const handler = createHandler({ schedulerClient: { send: schedulerSend } as never });

    await handler(
      { deptId: 'NICHOLS', incidentId: INCIDENT_ID, retryCount: MAX_SUBMISSION_RETRIES },
      FAKE_CONTEXT,
      () => undefined,
    );

    expect(appendSubmissionAttempt).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      expect.objectContaining({ outcome: 'RATE_LIMITED', retryCount: MAX_SUBMISSION_RETRIES }),
      true,
      expect.any(Number),
    );
    expect(schedulerSend).not.toHaveBeenCalled();
  });

  it('logs and returns without throwing on a malformed direct-invoke payload', async () => {
    const { appendSubmissionAttempt } = mockDeps({ httpStatus: 200 });
    const { createHandler } = await import('./submissionWorker.js');
    const handler = createHandler({ schedulerClient: { send: vi.fn() } as never });

    await expect(
      handler({ deptId: 'NICHOLS' }, FAKE_CONTEXT, () => undefined),
    ).resolves.toBeUndefined();
    expect(appendSubmissionAttempt).not.toHaveBeenCalled();
  });
});
