import type { DynamoDBRecord, DynamoDBStreamHandler } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  createDynamoDocClient,
  createEventBridgeClient,
  readPersonnelServiceConfig,
} from '../awsClients.js';

interface OutboxEnvelope {
  readonly eventId: string;
  readonly eventTime: string;
  readonly eventType: string;
  readonly source: string;
  readonly correlationId: string;
  readonly schemaVersion: string;
  readonly payload: Record<string, unknown>;
}

function emitOutboxMetric(outcome: 'Succeeded' | 'Failed', reason?: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/PersonnelService',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: `OutboxPublish${outcome}`, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [`OutboxPublish${outcome}`]: 1,
    }),
  );
}

function readUnsentOutboxRecord(record: DynamoDBRecord) {
  if (record.eventName !== 'INSERT') {
    return undefined;
  }
  const image = record.dynamodb?.NewImage;
  if (!image) {
    return undefined;
  }
  const item = unmarshall(image as Record<string, never>) as Record<string, unknown>;
  if (item.entityType !== 'OUTBOX' || item.sent !== false) {
    return undefined;
  }
  const { pk, sk } = item as Record<string, string>;
  const envelope = item.envelope as OutboxEnvelope | undefined;
  if (typeof pk !== 'string' || typeof sk !== 'string' || !envelope) {
    return undefined;
  }
  return { pk, sk, envelope };
}

export const handler: DynamoDBStreamHandler = async (event) => {
  const config = readPersonnelServiceConfig(process.env);
  const docClient = createDynamoDocClient();
  const eventBridgeClient = createEventBridgeClient();
  const batchItemFailures: { itemIdentifier: string }[] = [];

  await Promise.allSettled(
    event.Records.map(async (record) => {
      let outboxRecord: ReturnType<typeof readUnsentOutboxRecord>;
      try {
        outboxRecord = readUnsentOutboxRecord(record);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'personnel.outbox.publish.malformedRecord',
            service: 'personnel-service',
            eventId: record.eventID,
            reason: error instanceof Error ? error.constructor.name : 'UnknownError',
            message: error instanceof Error ? error.message : undefined,
          }),
        );
        return;
      }
      if (!outboxRecord) {
        return;
      }
      const { pk, sk, envelope } = outboxRecord;

      try {
        const putResult = await eventBridgeClient.send(
          new PutEventsCommand({
            Entries: [
              {
                EventBusName: config.busName,
                Source: envelope.source,
                DetailType: envelope.eventType,
                Detail: JSON.stringify(envelope),
              },
            ],
          }),
        );
        const failedEntry = putResult.Entries?.[0];
        if ((putResult.FailedEntryCount ?? 0) > 0) {
          throw new Error(
            `PutEvents entry failed: ${failedEntry?.ErrorCode ?? 'UnknownError'} - ${failedEntry?.ErrorMessage ?? 'no message'}`,
          );
        }
        await docClient.send(
          new UpdateCommand({
            TableName: config.tableName,
            Key: { pk, sk },
            UpdateExpression: 'SET sent = :sent',
            ConditionExpression: 'sent = :unsent',
            ExpressionAttributeValues: { ':sent': true, ':unsent': false },
          }),
        );
        emitOutboxMetric('Succeeded');
      } catch (error) {
        const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
        console.error(
          JSON.stringify({
            event: 'personnel.outbox.publish.failed',
            service: 'personnel-service',
            sk,
            reason,
            message: error instanceof Error ? error.message : undefined,
          }),
        );
        emitOutboxMetric('Failed', reason);
        if (record.dynamodb?.SequenceNumber) {
          batchItemFailures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
        }
      }
    }),
  );

  return { batchItemFailures };
};
