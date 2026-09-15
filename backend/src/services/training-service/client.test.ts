import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent } from '@boxalarm/authz';

function buildEvent(
  headers: Record<string, string>,
  principal?: Record<string, unknown>,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/training/events',
    rawPath: '/api/v1/training/events',
    rawQueryString: '',
    headers,
    requestContext: { authorizer: { lambda: principal } },
  } as unknown as GuardEvent;
}

describe('training-service client', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.TRAINING_TABLE_NAME = 'platform-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('readTrainingConfig reads the table name and throws (fail-closed) when absent', async () => {
    const { readTrainingConfig } = await import('./client.js');
    expect(readTrainingConfig({ TRAINING_TABLE_NAME: 'platform-table' })).toEqual({
      tableName: 'platform-table',
    });
    expect(() => readTrainingConfig({})).toThrow('TRAINING_TABLE_NAME is required');
  });

  it('createDocumentClient throws when config is missing and caches one client across calls', async () => {
    delete process.env.TRAINING_TABLE_NAME;
    const { createDocumentClient } = await import('./client.js');
    expect(() => createDocumentClient(process.env)).toThrow('TRAINING_TABLE_NAME is required');

    process.env.TRAINING_TABLE_NAME = 'platform-table';
    const fakeClient = {} as DynamoDBDocumentClient;
    const first = createDocumentClient(process.env, fakeClient);
    const second = createDocumentClient(process.env);
    expect(first).toBe(fakeClient);
    expect(second).toBe(fakeClient);
  });

  it('extractTraceId falls back to a random id, else parses the W3C traceparent header', async () => {
    const { extractTraceId } = await import('./client.js');
    expect(extractTraceId(buildEvent({}))).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      extractTraceId(
        buildEvent({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }),
      ),
    ).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('extractBearerToken extracts only a well-formed Bearer header', async () => {
    const { extractBearerToken } = await import('./client.js');
    expect(extractBearerToken(buildEvent({}))).toBeUndefined();
    expect(extractBearerToken(buildEvent({ authorization: 'Basic abc' }))).toBeUndefined();
    expect(extractBearerToken(buildEvent({ authorization: 'Bearer tok-1' }))).toBe('tok-1');
  });

  it('resolveTrainingPrincipal resolves a valid principal and rejects a missing or malformed one', async () => {
    const { resolveTrainingPrincipal } = await import('./client.js');
    expect(resolveTrainingPrincipal(buildEvent({}, undefined))).toBeUndefined();
    expect(
      resolveTrainingPrincipal(buildEvent({}, { sub: 'member-1', deptId: 'dept-001' })),
    ).toEqual({ sub: 'member-1', deptId: 'dept-001' });

    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const principal = resolveTrainingPrincipal(
      buildEvent({}, { sub: 'member-1', deptId: 'dept#001#bad' }),
    );
    expect(principal).toBeUndefined();
    expect(logSpy.mock.calls[0]?.[0] as string).toContain('training.principal.invalid');
    logSpy.mockRestore();
  });

  it('emitTrainingMetric emits an EMF metric, with a Reason dimension only when a reason is given', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { emitTrainingMetric } = await import('./client.js');

    emitTrainingMetric('TrainingEventCreated');
    const noReason = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(noReason._aws).toMatchObject({
      CloudWatchMetrics: [{ Namespace: 'Boxalarm/Training', Dimensions: [[]] }],
    });
    expect(noReason.TrainingEventCreated).toBe(1);
    expect(noReason.Reason).toBeUndefined();

    emitTrainingMetric('TrainingSignupFailed', 'DuplicateSignup');
    const withReason = JSON.parse(logSpy.mock.calls[1]?.[0] as string) as Record<string, unknown>;
    expect(withReason._aws).toMatchObject({
      CloudWatchMetrics: [{ Dimensions: [[], ['Reason']] }],
    });
    expect(withReason.Reason).toBe('DuplicateSignup');
    logSpy.mockRestore();
  });
});
