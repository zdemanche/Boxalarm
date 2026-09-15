import { unmarshall } from '@aws-sdk/util-dynamodb';
import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';
import { createEventBridgeClient, readEventBusConfig } from './eventBridgeClient.js';
import { createDynamoClient, readPersonnelConfig } from '../dynamoClient.js';

interface OutboxEntry {
  readonly entityType: string;
  readonly eventId: string;
  readonly eventTime: string;
  readonly eventType: string;
  readonly source: string;
  readonly correlationId: string;
  readonly schemaVersion: string;
  readonly payload: Record<string, unknown>;
  readonly sentAt: string | null;
}

function emitOutboxMetric(outcome: 'Published' | 'Failed'): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/PushToken',
            Dimensions: [[]],
            Metrics: [{ Name: `Outbox${outcome}`, Unit: 'Count' }],
          },
        ],
      },
      [`Outbox${outcome}`]: 1,
    }),
  );
}

export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  const eventBridgeClient = createEventBridgeClient(process.env);
  const busName = readEventBusConfig(process.env).busName;
  const dynamoClient = createDynamoClient(process.env);
  const tableName = readPersonnelConfig(process.env).tableName;

  for (const record of event.Records) {
    const newImage = record.dynamodb?.NewImage;
    const keys = record.dynamodb?.Keys;
    if (record.eventName !== 'INSERT' || !newImage || !keys) {
      continue;
    }
    const entry = unmarshall(newImage as Parameters<typeof unmarshall>[0]) as OutboxEntry;
    if (entry.entityType !== 'OUTBOX_ENTRY' || entry.sentAt) {
      continue;
    }
    const streamRecordKey = unmarshall(keys as Parameters<typeof unmarshall>[0]) as Record<
      string,
      string
    >;

    try {
      const putResult = await eventBridgeClient.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: busName,
              Source: entry.source,
              DetailType: entry.eventType,
              Detail: JSON.stringify({
                eventId: entry.eventId,
                eventTime: entry.eventTime,
                eventType: entry.eventType,
                source: entry.source,
                correlationId: entry.correlationId,
                schemaVersion: entry.schemaVersion,
                payload: entry.payload,
              }),
            },
          ],
        }),
      );
      if (putResult.FailedEntryCount && putResult.FailedEntryCount > 0) {
        throw new Error(
          `PutEvents rejected the outbox entry: ${putResult.Entries?.[0]?.ErrorCode ?? 'unknown error'}`,
        );
      }
      await dynamoClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: streamRecordKey,
          UpdateExpression: 'SET sentAt = :sentAt',
          ExpressionAttributeValues: { ':sentAt': new Date().toISOString() },
        }),
      );
      emitOutboxMetric('Published');
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'personnel.outbox.publish.failed',
          service: 'personnel-service',
          correlationId: entry.correlationId,
          eventId: entry.eventId,
          reason: error instanceof Error ? error.constructor.name : 'UnknownError',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      emitOutboxMetric('Failed');
      throw error;
    }
  }

  return { batchItemFailures: [] };
};
