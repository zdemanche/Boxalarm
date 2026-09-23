import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { captureSpy } = vi.hoisted(() => ({ captureSpy: vi.fn((client: unknown) => client) }));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {},
}));

vi.mock('aws-xray-sdk-core', () => ({
  default: { captureAWSv3Client: captureSpy },
  captureAWSv3Client: captureSpy,
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: (client: unknown) => client },
}));

describe('reporting-service dynamoClient', () => {
  beforeEach(() => {
    vi.resetModules();
    captureSpy.mockClear();
  });

  it('readPersonnelTableConfig throws (fail-closed) when PERSONNEL_TABLE_NAME is unset', async () => {
    const { readPersonnelTableConfig } = await import('./dynamoClient.js');
    expect(() => readPersonnelTableConfig({})).toThrow('PERSONNEL_TABLE_NAME');
  });

  it('readAttendanceTableConfig throws (fail-closed) when PLATFORM_SERVICE_TABLE_NAME is unset', async () => {
    const { readAttendanceTableConfig } = await import('./dynamoClient.js');
    expect(() => readAttendanceTableConfig({})).toThrow('PLATFORM_SERVICE_TABLE_NAME');
  });

  it('readPersonnelTableConfig/readAttendanceTableConfig return the configured table names', async () => {
    const { readPersonnelTableConfig, readAttendanceTableConfig } =
      await import('./dynamoClient.js');
    const env = { PERSONNEL_TABLE_NAME: 'personnel', PLATFORM_SERVICE_TABLE_NAME: 'platform' };
    expect(readPersonnelTableConfig(env)).toEqual({ tableName: 'personnel' });
    expect(readAttendanceTableConfig(env)).toEqual({ tableName: 'platform' });
  });

  it('createDynamoClient wraps the DynamoDB client with X-Ray tracing (xray-tracing)', async () => {
    const { createDynamoClient } = await import('./dynamoClient.js');
    const env = { PERSONNEL_TABLE_NAME: 'personnel', PLATFORM_SERVICE_TABLE_NAME: 'platform' };
    createDynamoClient(env);
    expect(captureSpy).toHaveBeenCalled();
  });

  it('createDynamoClient caches the client across invocations', async () => {
    const { createDynamoClient } = await import('./dynamoClient.js');
    const env = { PERSONNEL_TABLE_NAME: 'personnel', PLATFORM_SERVICE_TABLE_NAME: 'platform' };
    const first = createDynamoClient(env);
    const second = createDynamoClient(env);
    expect(first).toBe(second);
  });

  it('createDynamoClient throws (fail-closed) when either table env var is missing', async () => {
    const { createDynamoClient } = await import('./dynamoClient.js');
    expect(() => createDynamoClient({ PERSONNEL_TABLE_NAME: 'personnel' })).toThrow();
  });

  it('createRawDynamoClient wraps the raw DynamoDB client with X-Ray tracing', async () => {
    const { createRawDynamoClient } = await import('./dynamoClient.js');
    const env = { PERSONNEL_TABLE_NAME: 'personnel', PLATFORM_SERVICE_TABLE_NAME: 'platform' };
    createRawDynamoClient(env);
    expect(captureSpy).toHaveBeenCalled();
  });
});

describe('logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logInfo emits structured JSON with service, event, and correlationId', async () => {
    const { logInfo } = await import('./dynamoClient.js');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logInfo('reporting.query_started', 'trace-1', { deptId: 'NICHOLS' });

    const logged = JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged).toMatchObject({
      level: 'info',
      event: 'reporting.query_started',
      correlationId: 'trace-1',
      service: 'reporting-service',
      deptId: 'NICHOLS',
    });
  });

  it('logError logs the original error before returning a problem response (error-path-logging)', async () => {
    const { logError } = await import('./dynamoClient.js');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logError('reporting.query_failed', 'trace-1', new Error('DynamoDB unavailable'));

    const logged = JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.level).toBe('error');
    expect(logged.originalError).toBe('DynamoDB unavailable');
  });

  it('logError handles a non-Error thrown value', async () => {
    const { logError } = await import('./dynamoClient.js');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logError('reporting.query_failed', 'trace-1', 'plain string failure');

    const logged = JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.originalError).toBe('plain string failure');
  });
});
