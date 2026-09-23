import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import AWSXRay from 'aws-xray-sdk-core';
import { emitEmf as emitEmfMetric } from '@boxalarm/metrics';

export interface TrainingDynamoConfig {
  readonly tableName: string;
}

export function readTrainingDynamoConfig(env: NodeJS.ProcessEnv): TrainingDynamoConfig {
  const tableName = env.TRAINING_DYNAMO_TABLE_NAME;
  if (!tableName) {
    throw new Error('TRAINING_DYNAMO_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

let cachedClient: DynamoDBDocumentClient | undefined;

export function createDynamoClient(client?: DynamoDBDocumentClient): DynamoDBDocumentClient {
  cachedClient ??=
    client ?? DynamoDBDocumentClient.from(AWSXRay.captureAWSv3Client(new DynamoDBClient({})));
  return cachedClient;
}

function emitEmf(
  namespace: string,
  metricName: string,
  dimensions: string[][],
  extra: Record<string, string>,
): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: namespace,
            Dimensions: dimensions,
            Metrics: [{ Name: metricName, Unit: 'Count' }],
          },
        ],
      },
      ...extra,
      [metricName]: 1,
    }),
  );
}

export type CertificationCreateOutcome = 'Created' | 'Failed' | 'Revoked';

export function emitCertificationMetric(outcome: CertificationCreateOutcome): void {
  emitEmf('Boxalarm/training', `Certification${outcome}`, [[]], {});
}

export function emitExpiryScanMetric(count: number): void {
  emitEmfMetric('Boxalarm/training', 'CertificationsExpired', count, [[]], {});
}
