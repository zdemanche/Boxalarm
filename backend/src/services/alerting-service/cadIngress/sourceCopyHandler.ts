import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError, logInfo } from '../dispatches/logger.js';
import { CAD_METRIC_NAMESPACE } from './metrics.js';
import { cadIngressCopyKey, toCadSource } from './sourceCopy.js';

/**
 * The department's CAD_INGRESS config, projected into the alerting table as CAD_INGRESS_COPY
 * (sourceCopy.ts) - the item both ingress Lambdas read. Same shape as the ALERT_RULES_COPY
 * consumer (alertRules/alertRulesCopyHandler.ts): an alerting-owned consumer of
 * `platform.config.updated`, replacing the copy whole on each newer version, under the
 * alerting permissions boundary. The chief's config route never writes the alerting table.
 *
 * Each source is re-validated here; an invalid one is dropped (and counted), so a bad entry
 * can never widen what the ingress Lambdas accept.
 */

interface CadIngressUpdate {
  readonly deptId: string;
  readonly version: number;
  readonly sources: readonly unknown[];
  readonly eventTime: string;
}

type Parsed =
  | { readonly kind: 'cad-ingress'; readonly update: CadIngressUpdate }
  | { readonly kind: 'ignored' };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseCadConfigUpdated(body: string): Parsed {
  const detail = asRecord((JSON.parse(body) as { detail?: unknown }).detail);
  const payload = asRecord(detail?.payload);
  if (detail?.eventType !== 'platform.config.updated' || !payload) {
    throw new Error('platform.config.updated event failed shape validation');
  }
  if (payload.configType !== 'CAD_INGRESS') {
    return { kind: 'ignored' };
  }
  const value = asRecord(payload.value);
  if (
    typeof payload.deptId !== 'string' ||
    typeof payload.version !== 'number' ||
    !value ||
    !Array.isArray(value.sources) ||
    typeof detail.eventTime !== 'string'
  ) {
    throw new Error('platform.config.updated CAD_INGRESS payload failed shape validation');
  }
  return {
    kind: 'cad-ingress',
    update: {
      deptId: payload.deptId,
      version: payload.version,
      sources: value.sources as unknown[],
      eventTime: detail.eventTime,
    },
  };
}

async function writeCopy(
  client: DynamoDBDocumentClient,
  tableName: string,
  update: CadIngressUpdate,
): Promise<'applied' | 'stale'> {
  const deptId = toVerifiedDeptId({ deptId: update.deptId });
  const sources = update.sources.map(toCadSource);
  const dropped = sources.filter((source) => source === undefined).length;
  if (dropped > 0) {
    logInfo('alerting.cadSourceCopy.sourceDropped', { deptId, version: update.version, dropped });
    emitOutcomeMetric(CAD_METRIC_NAMESPACE, 'CadSourceCopyDropped');
  }
  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...cadIngressCopyKey(deptId),
          entityType: 'CAD_INGRESS_COPY',
          deptId,
          sourceVersion: update.version,
          snapshotUpdatedAt: Date.parse(update.eventTime),
          sources: sources.filter((source) => source !== undefined),
        },
        // Versions only move forward: a redelivered older config never replaces a newer one.
        ConditionExpression: 'attribute_not_exists(pk) OR sourceVersion < :version',
        ExpressionAttributeValues: { ':version': update.version },
      }),
    );
    return 'applied';
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return 'stale';
    }
    throw error;
  }
}

async function processRecord(
  record: SQSRecord,
  client: DynamoDBDocumentClient,
  tableName: string,
): Promise<void> {
  let parsed: Parsed;
  try {
    parsed = parseCadConfigUpdated(record.body);
  } catch (error) {
    logError('alerting.cadSourceCopy.malformed', error, { correlationId: record.messageId });
    emitOutcomeMetric(CAD_METRIC_NAMESPACE, 'CadSourceCopyFailed', 'Malformed');
    throw error;
  }
  if (parsed.kind === 'ignored') {
    return;
  }
  try {
    const outcome = await writeCopy(client, tableName, parsed.update);
    logInfo('alerting.cadSourceCopy.written', {
      deptId: parsed.update.deptId,
      version: parsed.update.version,
      outcome,
    });
    emitOutcomeMetric(
      CAD_METRIC_NAMESPACE,
      outcome === 'applied' ? 'CadSourceCopyUpdated' : 'CadSourceCopyStale',
    );
  } catch (error) {
    logError('alerting.cadSourceCopy.writeFailed', error, {
      correlationId: record.messageId,
      deptId: parsed.update.deptId,
    });
    emitOutcomeMetric(CAD_METRIC_NAMESPACE, 'CadSourceCopyFailed', 'WriteFailed');
    throw error;
  }
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const client = createDynamoClient(process.env);
  const { tableName } = readAlertingConfig(process.env);
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      await processRecord(record, client, tableName);
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
