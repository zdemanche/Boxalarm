import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

describe('readTrainingDynamoConfig', () => {
  it('throws a descriptive error when TRAINING_DYNAMO_TABLE_NAME is not set', async () => {
    const { readTrainingDynamoConfig } = await import('./dynamoClient.js');
    expect(() => readTrainingDynamoConfig({})).toThrow(
      'TRAINING_DYNAMO_TABLE_NAME is required and was not set',
    );
  });

  it('returns the configured table name', async () => {
    const { readTrainingDynamoConfig } = await import('./dynamoClient.js');
    expect(readTrainingDynamoConfig({ TRAINING_DYNAMO_TABLE_NAME: 'platform-service' })).toEqual({
      tableName: 'platform-service',
    });
  });
});

describe('createDynamoClient', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('memoizes the client across calls, ignoring a later override once cached', async () => {
    const { createDynamoClient } = await import('./dynamoClient.js');
    const injected = {} as unknown as DynamoDBDocumentClient;
    const other = {} as unknown as DynamoDBDocumentClient;

    const first = createDynamoClient(injected);
    const second = createDynamoClient(other);

    expect(first).toBe(injected);
    expect(second).toBe(injected);
  });
});

describe('emitCertificationMetric', () => {
  it('emits an EMF blob under the Boxalarm/Training namespace, named by outcome', async () => {
    const { emitCertificationMetric } = await import('./dynamoClient.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    emitCertificationMetric('Created');
    emitCertificationMetric('Failed');

    expect(logSpy).toHaveBeenCalledTimes(2);
    const created = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      CertificationCreated: number;
      _aws: { CloudWatchMetrics: { Namespace: string }[] };
    };
    expect(created.CertificationCreated).toBe(1);
    expect(created._aws.CloudWatchMetrics[0]?.Namespace).toBe('Boxalarm/Training');

    const failed = JSON.parse(logSpy.mock.calls[1]?.[0] as string) as {
      CertificationFailed: number;
    };
    expect(failed.CertificationFailed).toBe(1);

    logSpy.mockRestore();
  });
});
