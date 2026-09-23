import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';

vi.mock('./authorization.js', () => ({
  getVerifiedPermissionsClient: vi.fn(() => ({})),
  readAuthorizationConfig: vi.fn(() => ({ policyStoreId: 'store-1' })),
  authorizeManualDispatchSubmission: vi.fn(),
}));

vi.mock('./dynamoClient.js', () => ({
  getDynamoClient: vi.fn(() => ({})),
  readDispatchesConfig: vi.fn(() => ({ tableName: 'alerting-dispatches' })),
}));

vi.mock('./repository.js', () => ({
  createManualDispatch: vi.fn(),
}));

vi.mock('../fanout/fanOut.js', () => ({
  runFanOut: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../escalation/scheduleEscalation.js', () => ({
  getSchedulerClient: vi.fn(() => ({})),
}));

interface DispatchAuthorizerContext {
  readonly sub: string;
  readonly deptId: string;
  readonly 'cognito:groups': string;
}

type DispatchEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<DispatchAuthorizerContext>;

const VALID_BODY = {
  incidentType: 'STRUCTURE_FIRE',
  address: '123 Main St',
  crossStreets: 'Main & Elm',
  narrative: 'Smoke showing',
  externalDispatchId: 'op-4471',
};

function buildEvent(opts: {
  headers?: Record<string, string>;
  body?: string;
  authorizerContext?: Record<string, unknown>;
}): DispatchEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/alerting/dispatches',
    rawPath: '/api/v1/alerting/dispatches',
    rawQueryString: '',
    cookies: [],
    headers: opts.headers ?? {},
    isBase64Encoded: false,
    body: opts.body,
    requestContext: {
      requestId: 'req-1',
      authorizer: { lambda: opts.authorizerContext },
    },
  } as unknown as DispatchEvent;
}

const AUTH_CONTEXT = { sub: 'member-0012', deptId: 'NICHOLS', 'cognito:groups': 'OFFICER' };
const AUTH_HEADERS = { authorization: 'Bearer token-1' };

describe('handler (POST /api/v1/alerting/dispatches)', () => {
  beforeEach(() => {
    process.env.ALERTING_DISPATCHES_TABLE_NAME = 'alerting-dispatches';
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'store-1';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when the authorizer context is missing (entrypoint test)', async () => {
    const { handler } = await import('./handler.js');
    const event = buildEvent({ headers: AUTH_HEADERS });
    const result = (await handler(event, {} as never, () => undefined)) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(401);
  });

  it('returns 401 when no bearer token is present', async () => {
    const { handler } = await import('./handler.js');
    const event = buildEvent({ authorizerContext: AUTH_CONTEXT });
    const result = (await handler(event, {} as never, () => undefined)) as { statusCode: number };
    expect(result.statusCode).toBe(401);
  });

  it('returns 503 when Verified Permissions is unavailable — fail-secure, never a defaulted allow', async () => {
    const { authorizeManualDispatchSubmission } = await import('./authorization.js');
    vi.mocked(authorizeManualDispatchSubmission).mockResolvedValue('UNAVAILABLE');

    const { handler } = await import('./handler.js');
    const event = buildEvent({
      headers: AUTH_HEADERS,
      authorizerContext: AUTH_CONTEXT,
      body: JSON.stringify(VALID_BODY),
    });
    const result = (await handler(event, {} as never, () => undefined)) as { statusCode: number };
    expect(result.statusCode).toBe(503);
  });

  it('returns 403 for a non-admin, non-officer member (AC3)', async () => {
    const { authorizeManualDispatchSubmission } = await import('./authorization.js');
    vi.mocked(authorizeManualDispatchSubmission).mockResolvedValue('DENIED');

    const { handler } = await import('./handler.js');
    const event = buildEvent({
      headers: AUTH_HEADERS,
      authorizerContext: AUTH_CONTEXT,
      body: JSON.stringify(VALID_BODY),
    });
    const result = (await handler(event, {} as never, () => undefined)) as { statusCode: number };
    expect(result.statusCode).toBe(403);
  });

  it('returns 400 with RFC 7807 field errors for an absent request body', async () => {
    const { authorizeManualDispatchSubmission } = await import('./authorization.js');
    vi.mocked(authorizeManualDispatchSubmission).mockResolvedValue('ALLOWED');

    const { handler } = await import('./handler.js');
    const event = buildEvent({ headers: AUTH_HEADERS, authorizerContext: AUTH_CONTEXT });
    const result = (await handler(event, {} as never, () => undefined)) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(400);
    const parsed = JSON.parse(result.body) as { errors: unknown[] };
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it('returns 400 for a required field missing (address)', async () => {
    const { authorizeManualDispatchSubmission } = await import('./authorization.js');
    vi.mocked(authorizeManualDispatchSubmission).mockResolvedValue('ALLOWED');

    const { handler } = await import('./handler.js');
    const withoutAddress: Record<string, unknown> = { ...VALID_BODY };
    delete withoutAddress.address;
    const event = buildEvent({
      headers: AUTH_HEADERS,
      authorizerContext: AUTH_CONTEXT,
      body: JSON.stringify(withoutAddress),
    });
    const result = (await handler(event, {} as never, () => undefined)) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(400);
    const parsed = JSON.parse(result.body) as { errors: { field: string }[] };
    expect(parsed.errors).toContainEqual(expect.objectContaining({ field: 'address' }));
  });

  it("returns 400 for an externalDispatchId containing '#'", async () => {
    const { authorizeManualDispatchSubmission } = await import('./authorization.js');
    vi.mocked(authorizeManualDispatchSubmission).mockResolvedValue('ALLOWED');

    const { handler } = await import('./handler.js');
    const event = buildEvent({
      headers: AUTH_HEADERS,
      authorizerContext: AUTH_CONTEXT,
      body: JSON.stringify({ ...VALID_BODY, externalDispatchId: 'bad#id' }),
    });
    const result = (await handler(event, {} as never, () => undefined)) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('returns 409 for a duplicate manual submission (AC4)', async () => {
    const { authorizeManualDispatchSubmission } = await import('./authorization.js');
    vi.mocked(authorizeManualDispatchSubmission).mockResolvedValue('ALLOWED');
    const { createManualDispatch } = await import('./repository.js');
    vi.mocked(createManualDispatch).mockResolvedValue({ outcome: 'duplicate' });

    const { handler } = await import('./handler.js');
    const event = buildEvent({
      headers: AUTH_HEADERS,
      authorizerContext: AUTH_CONTEXT,
      body: JSON.stringify(VALID_BODY),
    });
    const result = (await handler(event, {} as never, () => undefined)) as { statusCode: number };
    expect(result.statusCode).toBe(409);
  });

  it('returns 503 when DynamoDB is unavailable (non-conditional failure)', async () => {
    const { authorizeManualDispatchSubmission } = await import('./authorization.js');
    vi.mocked(authorizeManualDispatchSubmission).mockResolvedValue('ALLOWED');
    const { createManualDispatch } = await import('./repository.js');
    vi.mocked(createManualDispatch).mockRejectedValue(new Error('table not reachable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { handler } = await import('./handler.js');
    const event = buildEvent({
      headers: AUTH_HEADERS,
      authorizerContext: AUTH_CONTEXT,
      body: JSON.stringify(VALID_BODY),
    });
    const result = (await handler(event, {} as never, () => undefined)) as { statusCode: number };
    expect(result.statusCode).toBe(503);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('table not reachable'));
  });

  it('returns 201 for an admin, valid payload, first submission (AC2) and never leaks address/narrative into the response', async () => {
    const { authorizeManualDispatchSubmission } = await import('./authorization.js');
    vi.mocked(authorizeManualDispatchSubmission).mockResolvedValue('ALLOWED');
    const { createManualDispatch } = await import('./repository.js');
    vi.mocked(createManualDispatch).mockResolvedValue({
      outcome: 'created',
      dispatchId: 'NICHOLS-MANUAL-1798000000-abc12345',
    });

    const { handler } = await import('./handler.js');
    const event = buildEvent({
      headers: AUTH_HEADERS,
      authorizerContext: AUTH_CONTEXT,
      body: JSON.stringify(VALID_BODY),
    });
    const result = (await handler(event, {} as never, () => undefined)) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(201);
    const parsed = JSON.parse(result.body) as Record<string, unknown>;
    expect(parsed).toEqual({
      dispatchId: 'NICHOLS-MANUAL-1798000000-abc12345',
      sourceSystem: 'MANUAL',
    });
    expect(result.body).not.toContain(VALID_BODY.address);
    expect(result.body).not.toContain(VALID_BODY.narrative);

    const dispatchedAt = vi.mocked(createManualDispatch).mock.calls[0]?.[2]?.dispatchedAt;
    expect(dispatchedAt).toBeGreaterThan(1_000_000_000);
    expect(dispatchedAt).toBeLessThan(10_000_000_000);
  });

  it('invokes fan-out on a created dispatch, and a fan-out rejection does not affect the 201 ingress response', async () => {
    const { authorizeManualDispatchSubmission } = await import('./authorization.js');
    vi.mocked(authorizeManualDispatchSubmission).mockResolvedValue('ALLOWED');
    const { createManualDispatch } = await import('./repository.js');
    vi.mocked(createManualDispatch).mockResolvedValue({
      outcome: 'created',
      dispatchId: 'NICHOLS-MANUAL-1798000000-abc12345',
    });
    const { runFanOut } = await import('../fanout/fanOut.js');
    vi.mocked(runFanOut).mockRejectedValue(new Error('scheduler unavailable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { handler } = await import('./handler.js');
    const event = buildEvent({
      headers: AUTH_HEADERS,
      authorizerContext: AUTH_CONTEXT,
      body: JSON.stringify(VALID_BODY),
    });
    const result = (await handler(event, {} as never, () => undefined)) as { statusCode: number };

    expect(result.statusCode).toBe(201);
    expect(runFanOut).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'alerting-dispatches',
      'NICHOLS',
      'NICHOLS-MANUAL-1798000000-abc12345',
      expect.any(Number),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('scheduler unavailable'));
  });

  it('emits a DispatchIngress business metric on both accept and reject (business-metrics obligation)', async () => {
    const { authorizeManualDispatchSubmission } = await import('./authorization.js');
    vi.mocked(authorizeManualDispatchSubmission).mockResolvedValue('DENIED');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { handler } = await import('./handler.js');
    const event = buildEvent({
      headers: AUTH_HEADERS,
      authorizerContext: AUTH_CONTEXT,
      body: JSON.stringify(VALID_BODY),
    });
    await handler(event, {} as never, () => undefined);

    const metricLine = logSpy.mock.calls
      .map((call) => call[0] as string)
      .find((line) => line.includes('DispatchIngressRejected'));
    expect(metricLine).toBeDefined();
    const parsed = JSON.parse(metricLine ?? '{}') as {
      Reason?: string;
      _aws: { CloudWatchMetrics: { Dimensions: string[][] }[] };
    };
    expect(parsed.Reason).toBe('Forbidden');
    expect(parsed._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([[], ['Reason']]);
  });
});
