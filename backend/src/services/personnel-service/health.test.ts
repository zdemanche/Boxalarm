import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {},
}));

vi.mock('aws-xray-sdk-core', () => ({
  captureAWSv3Client: (client: unknown) => client,
}));

vi.mock('@aws-sdk/lib-dynamodb', () => {
  class FakeGetCommand {
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return {
    DynamoDBDocumentClient: { from: () => ({ send: sendMock }) },
    GetCommand: FakeGetCommand,
  };
});

const { livenessHandler, readinessHandler } = await import('./health.js');

describe('health handlers (entrypoint test)', () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.PERSONNEL_TABLE_NAME = 'boxalarm-dev-platform';
  });

  it('liveness always returns 200', async () => {
    const result = (await livenessHandler({}, {} as never, () => undefined)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(200);
  });

  it('readiness returns 200 when DynamoDB is reachable', async () => {
    sendMock.mockResolvedValueOnce({});
    const result = (await readinessHandler({}, {} as never, () => undefined)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(200);
    expect(sendMock.mock.calls[0]?.[0]).toMatchObject({
      input: {
        TableName: 'boxalarm-dev-platform',
        Key: { pk: 'DEPT#HEALTHCHECK#HEALTH', sk: 'PROBE' },
      },
    });
  });

  it('readiness returns 503 when DynamoDB is unreachable (fail-closed, not the alarm-worthy silence of a green check)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sendMock.mockRejectedValueOnce(new Error('ProvisionedThroughputExceeded'));
    const result = (await readinessHandler({}, {} as never, () => undefined)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(503);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ProvisionedThroughputExceeded'));
  });

  it('readiness returns 503 when PERSONNEL_TABLE_NAME is not configured (fail-closed)', async () => {
    delete process.env.PERSONNEL_TABLE_NAME;
    const result = (await readinessHandler({}, {} as never, () => undefined)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(503);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
