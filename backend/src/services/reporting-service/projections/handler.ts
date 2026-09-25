import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoDocClient, readReportingServiceConfig } from '../awsClients.js';
import { logError } from '../logger.js';
import { applyProjection } from './repository.js';
import { MalformedEventError, isProjectionEvent, parseDomainEvent } from './events.js';

const METRICS_NAMESPACE = 'Boxalarm/ReportingService';

export async function handleProjectionBatch(
  event: SQSEvent,
  client: DynamoDBDocumentClient,
  tableName: string,
  nowMs: () => number = Date.now,
): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const parsed = parseDomainEvent(record.body);
      if (!isProjectionEvent(parsed.eventType)) {
        continue;
      }
      const deptId = toVerifiedDeptId({ deptId: parsed.deptId });
      await applyProjection(client, tableName, deptId, parsed, nowMs());
      emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingProjectionApplied');
    } catch (error) {
      logError('reporting.projections.apply_failed', error, {
        messageId: record.messageId,
        malformed: error instanceof MalformedEventError,
      });
      emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingProjectionFailed');
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const { tableName } = readReportingServiceConfig(process.env);
  return handleProjectionBatch(event, createDynamoDocClient(), tableName);
};
