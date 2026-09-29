import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError, logInfo } from '../dispatches/logger.js';

const METRIC_NAMESPACE = 'Boxalarm/alerting-alert-rules-copy';

/**
 * The department's ALERT_RULES, projected into the alerting table as ALERT_RULES_COPY
 * (`DEPT#{deptId}#ALERT_RULES / METADATA`) - the item the escalation scheduler and the tone
 * evaluator read (escalation/scheduleEscalation.ts, escalation/toneLadder.ts). The alerting
 * plane never reads the platform table; this alerting-owned consumer of
 * `platform.config.updated` is how the rules arrive (design review M1: nothing wrote the copy,
 * so every ladder ran on the defaults while the settings page showed the chief's rules).
 *
 * The copy is replaced whole on each newer config version, so a field the chief removes falls
 * back to its default. Other config types are acknowledged and ignored (the rule filters on
 * ALERT_RULES too).
 */

interface AlertRulesUpdate {
  readonly deptId: string;
  readonly version: number;
  readonly value: Record<string, unknown>;
  readonly eventTime: string;
}

type Parsed =
  | { readonly kind: 'alert-rules'; readonly update: AlertRulesUpdate }
  | { readonly kind: 'ignored' };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseConfigUpdated(body: string): Parsed {
  const detail = asRecord((JSON.parse(body) as { detail?: unknown }).detail);
  const payload = asRecord(detail?.payload);
  if (detail?.eventType !== 'platform.config.updated' || !payload) {
    throw new Error('platform.config.updated event failed shape validation');
  }
  if (payload.configType !== 'ALERT_RULES') {
    return { kind: 'ignored' };
  }
  const value = asRecord(payload.value);
  if (
    typeof payload.deptId !== 'string' ||
    typeof payload.version !== 'number' ||
    !value ||
    typeof detail.eventTime !== 'string'
  ) {
    throw new Error('platform.config.updated ALERT_RULES payload failed shape validation');
  }
  return {
    kind: 'alert-rules',
    update: {
      deptId: payload.deptId,
      version: payload.version,
      value,
      eventTime: detail.eventTime,
    },
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * The copy in the shape its readers read. Only fields the platform validator accepts are
 * carried; anything else is dropped (and the reader's default applies), never passed through.
 */
export function toAlertRulesCopy(value: Record<string, unknown>): Record<string, unknown> {
  const toneLadderIn = asRecord(value.toneLadder) ?? {};
  const defaultRuleIn = asRecord(value.defaultRule) ?? {};
  const toneLadder: Record<string, number> = {};
  const tone2AtSeconds = positiveInteger(toneLadderIn.tone2AtSeconds);
  const tone3AtSeconds = positiveInteger(toneLadderIn.tone3AtSeconds);
  // escalationThresholdN is the seconds before a member's voice escalation.
  const escalationThresholdSeconds = positiveInteger(value.escalationThresholdN);
  if (tone2AtSeconds !== undefined) toneLadder.tone2AtSeconds = tone2AtSeconds;
  if (tone3AtSeconds !== undefined) toneLadder.tone3AtSeconds = tone3AtSeconds;
  if (escalationThresholdSeconds !== undefined) {
    toneLadder.escalationThresholdSeconds = escalationThresholdSeconds;
  }
  const defaultRule: Record<string, number | string[]> = {};
  const minResponders = positiveInteger(defaultRuleIn.minResponders);
  if (minResponders !== undefined) defaultRule.minResponders = minResponders;
  if (Array.isArray(defaultRuleIn.requiredQuals)) {
    defaultRule.requiredQuals = (defaultRuleIn.requiredQuals as unknown[]).filter(
      (qual): qual is string => typeof qual === 'string' && qual.length > 0,
    );
  }
  return {
    ...(Object.keys(toneLadder).length > 0 ? { toneLadder } : {}),
    ...(Object.keys(defaultRule).length > 0 ? { defaultRule } : {}),
  };
}

async function writeCopy(
  client: DynamoDBDocumentClient,
  tableName: string,
  update: AlertRulesUpdate,
): Promise<'applied' | 'stale'> {
  const deptId = toVerifiedDeptId({ deptId: update.deptId });
  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: buildDeptScopedPk(deptId, 'ALERT_RULES'),
          sk: 'METADATA',
          entityType: 'ALERT_RULES_COPY',
          deptId,
          sourceVersion: update.version,
          snapshotUpdatedAt: Date.parse(update.eventTime),
          ...toAlertRulesCopy(update.value),
        },
        // Versions only move forward: a redelivered or out-of-order older config never
        // replaces a newer one.
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
    parsed = parseConfigUpdated(record.body);
  } catch (error) {
    logError('alerting.alertRulesCopy.malformed', error, { correlationId: record.messageId });
    emitOutcomeMetric(METRIC_NAMESPACE, 'AlertRulesCopyFailed', 'Malformed');
    throw error;
  }
  if (parsed.kind === 'ignored') {
    return;
  }
  try {
    const outcome = await writeCopy(client, tableName, parsed.update);
    logInfo('alerting.alertRulesCopy.written', {
      deptId: parsed.update.deptId,
      version: parsed.update.version,
      outcome,
    });
    emitOutcomeMetric(
      METRIC_NAMESPACE,
      outcome === 'applied' ? 'AlertRulesCopyUpdated' : 'AlertRulesCopyStale',
    );
  } catch (error) {
    logError('alerting.alertRulesCopy.writeFailed', error, {
      correlationId: record.messageId,
      deptId: parsed.update.deptId,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'AlertRulesCopyFailed', 'WriteFailed');
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
