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

function fakeIncident(
  corePayload: Record<string, unknown> = { incident_type: 'FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE' },
) {
  return {
    incidentId: INCIDENT_ID,
    deptId: DEPT_ID,
    dispatchNumber: '4471',
    epochSeconds: 1_798_000_000,
    nerisSchemaVersion: '2026.2',
    corePayload,
    status: 'SUBMITTED',
    submissionStatus: 'SUBMITTED',
    lockedAt: 1_798_000_500,
    contentVersion: 3,
    lockedContentVersion: 3,
    sourceDispatchId: INCIDENT_ID,
    createdBy: 'MBR-0034',
    createdAt: 1_798_000_000,
    updatedAt: 1_798_000_000,
  };
}

const DEPT_NERIS_ID = 'FD09190828';

function mockDeps(options: {
  readonly httpStatus?: number;
  readonly responseBody?: unknown;
  readonly fetchError?: Error;
  readonly incidentExists?: boolean;
  readonly production?: boolean;
  readonly nerisIncidentId?: string;
  readonly pendingNerisId?: string;
  /** NERIS already holds the record (GET by id answers 200). */
  readonly existsInNeris?: boolean;
  readonly departmentNerisId?: string | null;
  readonly submissionsEnabled?: boolean;
  readonly nerisMissingAt?: number;
}) {
  const incident = {
    ...fakeIncident(),
    ...(options.nerisIncidentId ? { nerisIncidentId: options.nerisIncidentId } : {}),
    ...(options.pendingNerisId ? { pendingNerisId: options.pendingNerisId } : {}),
    ...(options.nerisMissingAt ? { nerisMissingAt: options.nerisMissingAt } : {}),
  };
  const getIncident = vi
    .fn()
    .mockResolvedValue(options.incidentExists === false ? undefined : incident);
  vi.doMock('../repository.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../repository.js')>();
    return {
      ...actual,
      getIncidentRepository: () => ({ getIncident }),
      getDocumentClient: () => ({ send: vi.fn() }),
      getTableName: () => 'incident-table',
    };
  });
  vi.doMock('../nerisSettings.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../nerisSettings.js')>();
    return {
      ...actual,
      getNerisDeptSettings: () =>
        Promise.resolve({
          ...actual.DEFAULT_NERIS_SETTINGS,
          ...(options.departmentNerisId === null
            ? {}
            : { departmentNerisId: options.departmentNerisId ?? DEPT_NERIS_ID }),
          ...(options.submissionsEnabled === false ? { submissionsEnabled: false } : {}),
          unitNerisIds: { E1: 'FD09190828S001U001' },
        }),
    };
  });
  vi.doMock('../reportContext.js', () => ({
    loadSchema: async () => ({
      nerisApi: (await import('./fixtures/neris-api-1.5.1.json', { with: { type: 'json' } }))
        .default,
    }),
  }));
  vi.doMock('../dispatchProjection.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../dispatchProjection.js')>();
    return {
      ...actual,
      queryIncidentResponseUnits: () =>
        Promise.resolve([{ unitId: 'E1', unitType: 'APPARATUS', dispatchedAt: 1_798_000_060 }]),
    };
  });

  const appendSubmissionAttempt = vi.fn().mockResolvedValue({ submissionStatus: 'RETRYING' });
  const markCreateInFlight = vi.fn().mockResolvedValue(undefined);
  const forgetMissingNerisRecord = vi.fn().mockResolvedValue(true);
  vi.doMock('../submissionRepository.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../submissionRepository.js')>();
    return {
      ...actual,
      getSubmissionRepository: () => ({
        appendSubmissionAttempt,
        markCreateInFlight,
        forgetMissingNerisRecord,
      }),
    };
  });

  const status = options.httpStatus ?? 201;
  const body =
    options.responseBody ??
    (status === 201
      ? {
          neris_id: `${DEPT_NERIS_ID}|4471|1798000000`,
          incident_status: { status: 'SUBMITTED' },
        }
      : status === 422
        ? {
            detail: [
              { loc: ['body', 'dispatch', 'call_create'], msg: 'Field required', type: 'missing' },
            ],
          }
        : {});
  const fetchFn = options.fetchError
    ? vi.fn().mockRejectedValue(options.fetchError)
    : vi.fn().mockImplementation((_path: string, init?: RequestInit) =>
        Promise.resolve(
          init?.method === 'GET'
            ? options.existsInNeris
              ? new Response(JSON.stringify({ incident_status: { status: 'SUBMITTED' } }), {
                  status: 200,
                })
              : new Response(JSON.stringify({ detail: 'Not Found' }), { status: 404 })
            : new Response(status === 204 ? null : JSON.stringify(body), { status }),
        ),
      );
  vi.doMock('./index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./index.js')>();
    return {
      ...actual,
      readNerisConfig: () =>
        Promise.resolve({
          baseUrl: 'https://api-test.neris.fsri.org/v1',
          userAgent: 'boxalarm/dev',
          clientId: 'c',
          clientSecret: 's',
        }),
      getNerisClient: () => ({ fetch: fetchFn }),
      isBoxalarmProductionEnvironment: () => options.production ?? false,
    };
  });

  return {
    getIncident,
    appendSubmissionAttempt,
    markCreateInFlight,
    forgetMissingNerisRecord,
    fetchFn,
  };
}

function unmockAll(): void {
  vi.unmock('../repository.js');
  vi.unmock('../submissionRepository.js');
  vi.unmock('../nerisSettings.js');
  vi.unmock('../dispatchProjection.js');
  vi.unmock('../reportContext.js');
  vi.unmock('./index.js');
}

describe('submissionWorker handler (SQS trigger)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NERIS_SUBMISSION_SCHEDULER_ROLE_ARN =
      'arn:aws:iam::111122223333:role/neris-submission-scheduler';
  });

  afterEach(() => {
    delete process.env.NERIS_SUBMISSION_SCHEDULER_ROLE_ARN;
    unmockAll();
    vi.restoreAllMocks();
  });

  it('finalizes SUCCESS on a 2xx response with no retry scheduled (AC4)', async () => {
    const { appendSubmissionAttempt } = mockDeps({ httpStatus: 201 });
    const { createHandler } = await import('./submissionWorker.js');
    const schedulerSend = vi.fn();
    const handler = createHandler({ schedulerClient: { send: schedulerSend } as never });

    const event: SQSEvent = { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] };
    const result = await handler(event, FAKE_CONTEXT, () => undefined);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(appendSubmissionAttempt).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      expect.objectContaining({
        outcome: 'SUCCESS',
        httpStatus: 201,
        retryCount: 0,
        operation: 'CREATE',
        nerisIncidentId: `${DEPT_NERIS_ID}|4471|1798000000`,
        nerisStatus: 'SUBMITTED',
        payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      }),
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

  it('creates with POST /incident/{department NERIS id} — the spec path, not /incidents', async () => {
    const { fetchFn } = mockDeps({ httpStatus: 201 });
    const { createHandler } = await import('./submissionWorker.js');
    const handler = createHandler({ schedulerClient: { send: vi.fn() } as never });

    await handler(
      { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] },
      FAKE_CONTEXT,
      () => undefined,
    );

    const [path, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/incident/${DEPT_NERIS_ID}`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, Record<string, unknown>>;
    expect(body.base).toMatchObject({
      department_neris_id: DEPT_NERIS_ID,
      incident_number: '4471',
    });
    expect(body.dispatch).toMatchObject({ incident_number: '4471' });
    expect(body.dispatch!.unit_responses).toEqual([
      expect.objectContaining({ reported_unit_id: 'E1', unit_neris_id: 'FD09190828S001U001' }),
    ]);
  });

  it('replaces by NERIS id (PUT /incident/{entity}/{neris id}, pipes encoded) once NERIS has the record', async () => {
    const nerisIncidentId = `${DEPT_NERIS_ID}|4471|1798000000`;
    const { fetchFn, appendSubmissionAttempt } = mockDeps({
      httpStatus: 200,
      responseBody: { last_modified: '2026-09-29T10:00:00Z' },
      nerisIncidentId,
    });
    const { createHandler } = await import('./submissionWorker.js');
    const handler = createHandler({ schedulerClient: { send: vi.fn() } as never });

    await handler(
      { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] },
      FAKE_CONTEXT,
      () => undefined,
    );

    const [path, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/incident/${DEPT_NERIS_ID}/${encodeURIComponent(nerisIncidentId)}`);
    expect(init.method).toBe('PUT');
    expect(appendSubmissionAttempt).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      expect.objectContaining({ outcome: 'SUCCESS', operation: 'UPDATE', nerisIncidentId }),
      true,
      expect.any(Number),
    );
  });

  it('re-creates a record NERIS no longer has instead of PUTting to its old id (round 2b, R3)', async () => {
    const oldId = `${DEPT_NERIS_ID}|4471|1798000000`;
    const { fetchFn, appendSubmissionAttempt, forgetMissingNerisRecord, markCreateInFlight } =
      mockDeps({ nerisIncidentId: oldId, nerisMissingAt: 1_798_100_000 });
    const { createHandler } = await import('./submissionWorker.js');
    await createHandler({ schedulerClient: { send: vi.fn() } as never })(
      { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] },
      FAKE_CONTEXT,
      () => undefined,
    );
    expect(forgetMissingNerisRecord).toHaveBeenCalledWith('NICHOLS', INCIDENT_ID, oldId);
    // Looked up first (NERIS might list it again), then created — never a PUT to the old id.
    const methods = fetchFn.mock.calls.map(([, init]) => (init as RequestInit).method);
    expect(methods).toEqual(['GET', 'POST']);
    expect(markCreateInFlight).toHaveBeenCalled();
    expect(appendSubmissionAttempt).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      expect.objectContaining({ outcome: 'SUCCESS', operation: 'CREATE' }),
      true,
      expect.any(Number),
    );
  });

  it('does not forget the NERIS id of a record that is not marked missing', async () => {
    const { forgetMissingNerisRecord } = mockDeps({
      httpStatus: 200,
      responseBody: { last_modified: '2026-09-29T10:00:00Z' },
      nerisIncidentId: `${DEPT_NERIS_ID}|4471|1798000000`,
    });
    const { createHandler } = await import('./submissionWorker.js');
    await createHandler({ schedulerClient: { send: vi.fn() } as never })(
      { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] },
      FAKE_CONTEXT,
      () => undefined,
    );
    expect(forgetMissingNerisRecord).not.toHaveBeenCalled();
  });

  it('records NERIS 422 issues on the attempt and in the failure reason', async () => {
    const { appendSubmissionAttempt } = mockDeps({ httpStatus: 422 });
    const { createHandler } = await import('./submissionWorker.js');
    const handler = createHandler({ schedulerClient: { send: vi.fn() } as never });

    await handler(
      { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] },
      FAKE_CONTEXT,
      () => undefined,
    );

    expect(appendSubmissionAttempt).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      expect.objectContaining({
        outcome: 'VALIDATION_ERROR',
        errors: [{ path: 'dispatch.call_create', code: 'missing', message: 'Field required' }],
        failureReason: expect.stringContaining('dispatch.call_create: Field required') as unknown,
      }),
      true,
      expect.any(Number),
    );
  });

  it('fails terminally as NOT_CONFIGURED, without calling NERIS, when the department has no NERIS id', async () => {
    const { appendSubmissionAttempt, fetchFn } = mockDeps({ departmentNerisId: null });
    const { createHandler } = await import('./submissionWorker.js');
    const handler = createHandler({ schedulerClient: { send: vi.fn() } as never });

    await handler(
      { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] },
      FAKE_CONTEXT,
      () => undefined,
    );

    expect(fetchFn).not.toHaveBeenCalled();
    expect(appendSubmissionAttempt).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      expect.objectContaining({ outcome: 'NOT_CONFIGURED' }),
      true,
      expect.any(Number),
    );
  });

  it('records a send stopped by the kill switch without notifying officers', async () => {
    const { appendSubmissionAttempt, fetchFn } = mockDeps({ submissionsEnabled: false });
    const { createHandler } = await import('./submissionWorker.js');
    const handler = createHandler({ schedulerClient: { send: vi.fn() } as never });

    await handler(
      { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] },
      FAKE_CONTEXT,
      () => undefined,
    );

    expect(fetchFn).not.toHaveBeenCalled();
    const attempt = appendSubmissionAttempt.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(attempt).toMatchObject({ outcome: 'NOT_CONFIGURED' });
    expect(attempt).not.toHaveProperty('notify');
  });

  it('treats a 401/403 as CLIENT_ERROR — terminal, and not a rejection of the report', async () => {
    const { appendSubmissionAttempt } = mockDeps({ httpStatus: 403 });
    const { createHandler } = await import('./submissionWorker.js');
    const schedulerSend = vi.fn();
    const handler = createHandler({ schedulerClient: { send: schedulerSend } as never });

    await handler(
      { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] },
      FAKE_CONTEXT,
      () => undefined,
    );

    expect(appendSubmissionAttempt).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      expect.objectContaining({ outcome: 'CLIENT_ERROR', httpStatus: 403 }),
      true,
      expect.any(Number),
    );
    expect(schedulerSend).not.toHaveBeenCalled();
  });

  it('records the expected NERIS id before a first create (review M2)', async () => {
    const { markCreateInFlight, fetchFn } = mockDeps({ httpStatus: 201 });
    const { createHandler } = await import('./submissionWorker.js');
    await createHandler({ schedulerClient: { send: vi.fn() } as never })(
      { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] },
      FAKE_CONTEXT,
      () => undefined,
    );
    expect(markCreateInFlight).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      `${DEPT_NERIS_ID}|4471|1798000000`,
    );
    // No existence check on a first attempt with no marker: straight to the create.
    expect((fetchFn.mock.calls[0] as [string, RequestInit])[1].method).toBe('POST');
  });

  it('adopts a record an earlier attempt created (lost 201) and replaces it instead of POSTing again', async () => {
    const pending = `${DEPT_NERIS_ID}|4471|1798000000`;
    const { fetchFn, appendSubmissionAttempt } = mockDeps({
      httpStatus: 200,
      responseBody: { last_modified: '2026-09-29T10:00:00Z' },
      pendingNerisId: pending,
      existsInNeris: true,
    });
    const { createHandler } = await import('./submissionWorker.js');
    await createHandler({ schedulerClient: { send: vi.fn() } as never })(
      { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] },
      FAKE_CONTEXT,
      () => undefined,
    );
    const methods = fetchFn.mock.calls.map(([, init]) => (init as RequestInit).method);
    expect(methods).toEqual(['GET', 'PUT']);
    expect(appendSubmissionAttempt).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      expect.objectContaining({ outcome: 'SUCCESS', operation: 'ADOPT', nerisIncidentId: pending }),
      true,
      expect.any(Number),
    );
  });

  it('treats a duplicate-create refusal as adopt, not a rejection', async () => {
    const { fetchFn, appendSubmissionAttempt } = mockDeps({ httpStatus: 409 });
    fetchFn.mockImplementation((_path: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'POST'
          ? new Response(JSON.stringify({ detail: 'Incident already exists' }), { status: 409 })
          : init?.method === 'GET'
            ? new Response(JSON.stringify({ incident_status: { status: 'SUBMITTED' } }), {
                status: 200,
              })
            : new Response(JSON.stringify({ last_modified: 'x' }), { status: 200 }),
      ),
    );
    const { createHandler } = await import('./submissionWorker.js');
    await createHandler({ schedulerClient: { send: vi.fn() } as never })(
      { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] },
      FAKE_CONTEXT,
      () => undefined,
    );
    expect(appendSubmissionAttempt).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      expect.objectContaining({ outcome: 'SUCCESS', operation: 'ADOPT' }),
      true,
      expect.any(Number),
    );
  });

  it('looks up and adopts on a plain 422 create when the record exists, whatever the wording (round 2, N1)', async () => {
    const { fetchFn, appendSubmissionAttempt } = mockDeps({ httpStatus: 422 });
    fetchFn.mockImplementation((_path: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'POST'
          ? new Response(
              JSON.stringify({
                detail: [{ loc: ['body'], msg: 'Record conflict', type: 'value_error' }],
              }),
              { status: 422 },
            )
          : init?.method === 'GET'
            ? new Response(JSON.stringify({ incident_status: { status: 'SUBMITTED' } }), {
                status: 200,
              })
            : new Response(JSON.stringify({ last_modified: 'x' }), { status: 200 }),
      ),
    );
    const { createHandler } = await import('./submissionWorker.js');
    await createHandler({ schedulerClient: { send: vi.fn() } as never })(
      { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] },
      FAKE_CONTEXT,
      () => undefined,
    );
    expect(appendSubmissionAttempt).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      expect.objectContaining({ outcome: 'SUCCESS', operation: 'ADOPT' }),
      true,
      expect.any(Number),
    );
  });

  it('does not schedule a retry for a failure a concurrent success superseded (round 2, N5)', async () => {
    const { appendSubmissionAttempt } = mockDeps({ httpStatus: 503 });
    appendSubmissionAttempt.mockResolvedValue({ submissionStatus: 'ACCEPTED', superseded: true });
    const { createHandler } = await import('./submissionWorker.js');
    const schedulerSend = vi.fn();
    await createHandler({ schedulerClient: { send: schedulerSend } as never })(
      { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] },
      FAKE_CONTEXT,
      () => undefined,
    );
    expect(schedulerSend).not.toHaveBeenCalled();
  });

  it('abandons without sending when the report was unlocked, edited or is no longer in flight (round 2, N2)', async () => {
    const { sendBlockedReason } = await import('./submissionWorker.js');
    const locked = {
      lockedAt: 1,
      submissionStatus: 'SUBMITTED',
      contentVersion: 3,
      lockedContentVersion: 3,
    };
    expect(sendBlockedReason(locked, locked)).toBeUndefined();
    expect(sendBlockedReason(locked, { ...locked, lockedAt: undefined })).toBe('NOT_LOCKED');
    expect(sendBlockedReason(locked, { ...locked, submissionStatus: 'FAILED' })).toBe(
      'NOT_IN_FLIGHT',
    );
    expect(sendBlockedReason(locked, { ...locked, contentVersion: 4 })).toBe('CONTENT_CHANGED');
    expect(sendBlockedReason(locked, { ...locked, lockedContentVersion: 2 })).toBe(
      'CONTENT_CHANGED',
    );
    expect(sendBlockedReason(locked, undefined)).toBe('MISSING');

    vi.resetModules();
    const { getIncident, fetchFn, appendSubmissionAttempt } = mockDeps({ httpStatus: 201 });
    getIncident.mockResolvedValueOnce({ ...fakeIncident(), ...locked }).mockResolvedValueOnce({
      ...fakeIncident(),
      ...locked,
      lockedAt: undefined,
      status: 'DRAFT',
    });
    const { createHandler } = await import('./submissionWorker.js');
    await createHandler({ schedulerClient: { send: vi.fn() } as never })(
      { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] },
      FAKE_CONTEXT,
      () => undefined,
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(appendSubmissionAttempt).not.toHaveBeenCalled();
    expect(getIncident).toHaveBeenCalledWith('NICHOLS', INCIDENT_ID, { consistent: true });
  });

  it('schedules each retry under a unique, self-deleting name recorded on the attempt (review M3)', async () => {
    const { appendSubmissionAttempt } = mockDeps({ httpStatus: 503 });
    const { createHandler, RETRY_SCHEDULE_PREFIX } = await import('./submissionWorker.js');
    const schedulerSend = vi.fn().mockResolvedValue({});
    const handler = createHandler({ schedulerClient: { send: schedulerSend } as never });
    const event: SQSEvent = { Records: [sqsRecord(submittedEnvelope('NICHOLS', INCIDENT_ID))] };

    await handler(event, FAKE_CONTEXT, () => undefined);
    await handler(event, FAKE_CONTEXT, () => undefined);

    const inputs = schedulerSend.mock.calls.map(
      ([command]) => (command as { input: Record<string, unknown> }).input,
    );
    expect(inputs).toHaveLength(2);
    const names = inputs.map((input) => String(input.Name));
    // Same report, same attempt number: still two distinct schedules, none truncated.
    expect(new Set(names).size).toBe(2);
    for (const input of inputs) {
      expect(String(input.Name).startsWith(RETRY_SCHEDULE_PREFIX)).toBe(true);
      expect(String(input.Name).length).toBeLessThanOrEqual(64);
      expect(input.ActionAfterCompletion).toBe('DELETE');
    }
    expect(appendSubmissionAttempt).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      expect.objectContaining({ retryScheduleName: names[0] }),
      false,
      expect.any(Number),
    );
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
    process.env.NERIS_SUBMISSION_SCHEDULER_ROLE_ARN =
      'arn:aws:iam::111122223333:role/neris-submission-scheduler';
  });

  afterEach(() => {
    delete process.env.NERIS_SUBMISSION_SCHEDULER_ROLE_ARN;
    unmockAll();
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
