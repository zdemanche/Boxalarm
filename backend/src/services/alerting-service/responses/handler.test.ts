import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedOptions {
  readonly actionType: string;
  readonly actionId: string;
  readonly resourceType: string;
  readonly resourceId: (event: { pathParameters?: { dispatchId?: string } }) => string;
}

const capturedOptions: CapturedOptions[] = vi.hoisted(() => []);

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

vi.mock('../eligibility/dynamoClient.js', () => ({
  readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
  createDynamoClient: vi.fn(() => ({})),
}));

vi.mock('./repository.js', () => ({
  recordResponse: vi.fn(),
}));

import { recordResponse } from './repository.js';
import { handler } from './handler.js';

const principal = { sub: 'MBR-0012', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' };

function buildEvent(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    pathParameters: { dispatchId: 'NICHOLS-4471-1798000000' },
    requestContext: { authorizer: { lambda: principal } },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

/** An arrival time `minutes` from now, in epoch seconds - the unit the app sends. */
function etaIn(minutes: number): number {
  return Math.floor(Date.now() / 1000) + minutes * 60;
}

function recorded(
  answer: Partial<{ ackStatus: string; eta: number | null }> = {},
  roster: 'APPLIED' | 'SUPERSEDED' = 'APPLIED',
  replayed = false,
) {
  return {
    outcome: 'recorded' as const,
    roster,
    replayed,
    answer: {
      ackStatus: 'RESPONDING' as const,
      eta: 6,
      assignedApparatusId: null,
      answeredAt: 1798000000,
      ...answer,
    } as never,
  };
}

describe('responses handler', () => {
  it('wires the RecordResponse action against the Dispatch resource', () => {
    expect(capturedOptions[capturedOptions.length - 1]).toMatchObject({
      actionType: 'Boxalarm::Action',
      actionId: 'RecordResponse',
      resourceType: 'Boxalarm::Dispatch',
    });
  });

  it('resolves the Cedar resourceId to the dispatchId path parameter', () => {
    const options = capturedOptions[capturedOptions.length - 1];
    expect(options?.resourceId(buildEvent())).toBe('NICHOLS-4471-1798000000');
    expect(options?.resourceId({})).toBe('');
  });

  it('returns 404 when dispatchId is missing from the path', async () => {
    const result = (await handler(buildEvent({ pathParameters: {} }))) as { statusCode: number };
    expect(result.statusCode).toBe(404);
    expect(recordResponse).not.toHaveBeenCalled();
  });

  it('returns 400 when ackStatus is missing', async () => {
    const result = (await handler(buildEvent({ body: JSON.stringify({ eta: etaIn(6) }) }))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
    expect(recordResponse).not.toHaveBeenCalled();
  });

  it('returns 400 when ackStatus is not a recognized enum value', async () => {
    const result = (await handler(
      buildEvent({ body: JSON.stringify({ ackStatus: 'MAYBE', eta: etaIn(6) }) }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  // Mobile review E: ETA is optional - an answer without one is recorded as unknown (null),
  // never rejected, because a rejected RESPONDING is a responder the officers never see.
  it.each([['RESPONDING'], ['DIRECT_TO_SCENE']])(
    'records %s with no ETA as eta null',
    async (ackStatus) => {
      vi.mocked(recordResponse).mockResolvedValue(recorded({ ackStatus, eta: null }));
      for (const body of [{ ackStatus }, { ackStatus, eta: null }]) {
        const result = (await handler(buildEvent({ body: JSON.stringify(body) }))) as {
          statusCode: number;
        };
        expect(result.statusCode).toBe(200);
      }
      expect(recordResponse).toHaveBeenCalledWith(
        expect.anything(),
        'alerting-table',
        expect.objectContaining({ ackStatus, eta: null }),
      );
    },
  );

  // Review MINOR-5: the unit is the arrival time in epoch seconds (what the app sends); a
  // duration in minutes (10) is refused rather than shown as a time in 1970.
  it.each([[0], [-3], [2.5], [10], [4_000_000_000]])(
    'returns 400 for a provided but invalid eta %j',
    async (eta) => {
      const result = (await handler(
        buildEvent({ body: JSON.stringify({ ackStatus: 'RESPONDING', eta }) }),
      )) as { statusCode: number };
      expect(result.statusCode).toBe(400);
    },
  );

  it('returns 400 when eta is wrong-typed', async () => {
    const result = (await handler(
      buildEvent({ body: JSON.stringify({ ackStatus: 'RESPONDING', eta: 'six' }) }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when eta is provided for NOT_RESPONDING', async () => {
    const result = (await handler(
      buildEvent({ body: JSON.stringify({ ackStatus: 'NOT_RESPONDING', eta: 6 }) }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 on malformed JSON body', async () => {
    const result = (await handler(buildEvent({ body: '{not-json' }))) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('returns 404 when the dispatch does not exist', async () => {
    vi.mocked(recordResponse).mockResolvedValue({ outcome: 'dispatch-not-found' });
    const result = (await handler(
      buildEvent({ body: JSON.stringify({ ackStatus: 'NOT_RESPONDING' }) }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(404);
  });

  it('returns 403 when the member has no eligibility snapshot for the department (AC3)', async () => {
    vi.mocked(recordResponse).mockResolvedValue({ outcome: 'ineligible' });
    const result = (await handler(
      buildEvent({ body: JSON.stringify({ ackStatus: 'NOT_RESPONDING' }) }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(403);
  });

  it('passes a 10-digit epoch-seconds answeredAt to recordResponse (P5)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T00:00:00.000Z'));
    vi.mocked(recordResponse).mockResolvedValue(recorded());
    await handler(buildEvent({ body: JSON.stringify({ ackStatus: 'RESPONDING', eta: etaIn(6) }) }));
    expect(recordResponse).toHaveBeenCalledWith(
      expect.anything(),
      'alerting-table',
      expect.objectContaining({ answeredAt: Math.floor(Date.now() / 1000) }),
    );
    const [, , input] = vi.mocked(recordResponse).mock.calls[0]!;
    expect(String((input as { answeredAt: number }).answeredAt)).toHaveLength(10);
    vi.useRealTimers();
  });

  it('returns 200 with the recorded response, using the caller sub as memberId (AC1, no impersonation)', async () => {
    vi.mocked(recordResponse).mockResolvedValue(recorded({ ackStatus: 'DIRECT_TO_SCENE', eta: 3 }));
    const result = (await handler(
      buildEvent({ body: JSON.stringify({ ackStatus: 'DIRECT_TO_SCENE', eta: etaIn(3) }) }),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      memberId: 'MBR-0012',
      ackStatus: 'DIRECT_TO_SCENE',
      eta: 3,
    });
    expect(recordResponse).toHaveBeenCalledWith(
      expect.anything(),
      'alerting-table',
      expect.objectContaining({
        memberId: 'MBR-0012',
        ackStatus: 'DIRECT_TO_SCENE',
        eta: etaIn(3),
      }),
    );
  });

  it('returns 503 (fail-closed) and does not swallow the error, when DynamoDB is unavailable at write', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(recordResponse).mockRejectedValue(new Error('table unavailable'));
    const result = (await handler(
      buildEvent({ body: JSON.stringify({ ackStatus: 'RESPONDING', eta: etaIn(6) }) }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(503);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('emits a business metric on success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(recordResponse).mockResolvedValue(recorded());
    await handler(buildEvent({ body: JSON.stringify({ ackStatus: 'RESPONDING', eta: etaIn(6) }) }));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ResponseConfirmed'));
  });

  it('emits a business metric on write failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(recordResponse).mockRejectedValue(new Error('table unavailable'));
    await handler(buildEvent({ body: JSON.stringify({ ackStatus: 'RESPONDING', eta: etaIn(6) }) }));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ResponseConfirmFailed'));
  });

  describe('client answer id and answer ordering (mobile review D)', () => {
    it('passes clientAnswerId and answeredAtMs through, ordering by when the member answered', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-15T00:00:10.000Z'));
      vi.mocked(recordResponse).mockResolvedValue(recorded());
      const answeredAtMs = Date.parse('2026-09-15T00:00:04.250Z');
      await handler(
        buildEvent({
          body: JSON.stringify({
            ackStatus: 'RESPONDING',
            eta: etaIn(6),
            clientAnswerId: 'ans-1',
            answeredAtMs,
          }),
        }),
      );
      expect(recordResponse).toHaveBeenCalledWith(
        expect.anything(),
        'alerting-table',
        expect.objectContaining({
          clientAnswerId: 'ans-1',
          answeredAtMs,
          answeredAt: Math.floor(answeredAtMs / 1000),
          receivedAtMs: Date.parse('2026-09-15T00:00:10.000Z'),
        }),
      );
      vi.useRealTimers();
    });

    it('clamps an answeredAtMs from a device clock running ahead to the server receipt time', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-15T00:00:10.000Z'));
      vi.mocked(recordResponse).mockResolvedValue(recorded());
      await handler(
        buildEvent({
          body: JSON.stringify({
            ackStatus: 'RESPONDING',
            eta: etaIn(6),
            answeredAtMs: Date.parse('2026-09-15T01:00:00.000Z'),
          }),
        }),
      );
      expect(recordResponse).toHaveBeenCalledWith(
        expect.anything(),
        'alerting-table',
        expect.objectContaining({ answeredAtMs: Date.parse('2026-09-15T00:00:10.000Z') }),
      );
      vi.useRealTimers();
    });

    it('accepts the answer id from the Idempotency-Key header', async () => {
      vi.mocked(recordResponse).mockResolvedValue(recorded());
      await handler(
        buildEvent({
          headers: { 'Idempotency-Key': 'hdr-1' },
          body: JSON.stringify({ ackStatus: 'RESPONDING', eta: etaIn(6) }),
        }),
      );
      expect(recordResponse).toHaveBeenCalledWith(
        expect.anything(),
        'alerting-table',
        expect.objectContaining({ clientAnswerId: 'hdr-1' }),
      );
    });

    it.each([
      ['a header and body that disagree', { 'idempotency-key': 'a' }, { clientAnswerId: 'b' }],
      ['an unusable id', {}, { clientAnswerId: 'has#hash' }],
      ['an answeredAtMs over a day old', {}, { answeredAtMs: 1_000 }],
    ])('answers 400 for %s', async (_label, headers, extra) => {
      const result = (await handler(
        buildEvent({
          headers,
          body: JSON.stringify({ ackStatus: 'RESPONDING', eta: etaIn(6), ...extra }),
        }),
      )) as { statusCode: number };
      expect(result.statusCode).toBe(400);
      expect(recordResponse).not.toHaveBeenCalled();
    });

    it('answers 409 SUPERSEDED - not 200 - when a later answer is already on the roster', async () => {
      vi.mocked(recordResponse).mockResolvedValue(recorded({}, 'SUPERSEDED'));
      const result = (await handler(
        buildEvent({ body: JSON.stringify({ ackStatus: 'NOT_RESPONDING' }) }),
      )) as { statusCode: number; body: string };
      expect(result.statusCode).toBe(409);
      expect(JSON.parse(result.body)).toMatchObject({ status: 409, code: 'SUPERSEDED' });
    });

    it('answers a replay with the original answer and marks it replayed', async () => {
      vi.mocked(recordResponse).mockResolvedValue(
        recorded({ ackStatus: 'RESPONDING', eta: 6 }, 'APPLIED', true),
      );
      const result = (await handler(
        buildEvent({
          body: JSON.stringify({ ackStatus: 'RESPONDING', eta: etaIn(6), clientAnswerId: 'ans-1' }),
        }),
      )) as { statusCode: number; headers: Record<string, string>; body: string };
      expect(result.statusCode).toBe(200);
      expect(result.headers['idempotent-replayed']).toBe('true');
      expect(JSON.parse(result.body)).toMatchObject({
        ackStatus: 'RESPONDING',
        clientAnswerId: 'ans-1',
      });
    });

    it('answers 409 ANSWER_ID_REUSED when an id is reused for a different answer', async () => {
      vi.mocked(recordResponse).mockResolvedValue({ outcome: 'answer-id-conflict' });
      const result = (await handler(
        buildEvent({
          body: JSON.stringify({ ackStatus: 'NOT_RESPONDING', clientAnswerId: 'ans-1' }),
        }),
      )) as { statusCode: number; body: string };
      expect(result.statusCode).toBe(409);
      expect(JSON.parse(result.body)).toMatchObject({ code: 'ANSWER_ID_REUSED' });
    });
  });
});
