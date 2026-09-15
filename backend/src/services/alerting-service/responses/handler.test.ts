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

describe('responses handler', () => {
  it('wires the RecordResponse action against the Dispatch resource', () => {
    expect(capturedOptions[capturedOptions.length - 1]).toMatchObject({
      actionType: 'AlertingService',
      actionId: 'RecordResponse',
      resourceType: 'Dispatch',
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
    const result = (await handler(buildEvent({ body: JSON.stringify({ eta: 6 }) }))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
    expect(recordResponse).not.toHaveBeenCalled();
  });

  it('returns 400 when ackStatus is not a recognized enum value', async () => {
    const result = (await handler(
      buildEvent({ body: JSON.stringify({ ackStatus: 'MAYBE', eta: 6 }) }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when eta is missing for RESPONDING', async () => {
    const result = (await handler(
      buildEvent({ body: JSON.stringify({ ackStatus: 'RESPONDING' }) }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

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

  it('returns 200 with the recorded response, using the caller sub as memberId (AC1, no impersonation)', async () => {
    vi.mocked(recordResponse).mockResolvedValue({ outcome: 'recorded' });
    const result = (await handler(
      buildEvent({ body: JSON.stringify({ ackStatus: 'DIRECT_TO_SCENE', eta: 3 }) }),
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
      expect.objectContaining({ memberId: 'MBR-0012', ackStatus: 'DIRECT_TO_SCENE', eta: 3 }),
    );
  });

  it('returns 503 (fail-closed) and does not swallow the error, when DynamoDB is unavailable at write', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(recordResponse).mockRejectedValue(new Error('table unavailable'));
    const result = (await handler(
      buildEvent({ body: JSON.stringify({ ackStatus: 'RESPONDING', eta: 6 }) }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(503);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('emits a business metric on success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(recordResponse).mockResolvedValue({ outcome: 'recorded' });
    await handler(buildEvent({ body: JSON.stringify({ ackStatus: 'RESPONDING', eta: 6 }) }));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ResponseConfirmed'));
  });

  it('emits a business metric on write failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(recordResponse).mockRejectedValue(new Error('table unavailable'));
    await handler(buildEvent({ body: JSON.stringify({ ackStatus: 'RESPONDING', eta: 6 }) }));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ResponseConfirmFailed'));
  });
});
