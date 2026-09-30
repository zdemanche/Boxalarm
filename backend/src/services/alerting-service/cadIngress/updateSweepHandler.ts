import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logInfo } from '../dispatches/logger.js';
import { emitCadMetric } from './metrics.js';
import { notifyUpdate } from './notifyUpdate.js';

/**
 * Every 5 minutes (EventBridge Scheduler): CAD updates still owing their UPDATE push. Each
 * older than 2 minutes is handed to the notifier again (idempotent - the CADUPDATE# claims make
 * a second run send nothing twice); each older than 10 minutes is counted as
 * CadUpdateUnnotified, which is alarmed. This is what catches an update whose hand-off never
 * happened because the ingress Lambda died between commit and invoke.
 */
export const REDRIVE_AFTER_SECONDS = 120;
export const ALARM_AFTER_SECONDS = 600;

export const handler = async (): Promise<{ pending: number; stale: number }> => {
  const { tableName } = readAlertingConfig(process.env);
  const deptIdRaw = process.env.CAD_SWEEP_DEPT_ID;
  if (!deptIdRaw) throw new Error('CAD_SWEEP_DEPT_ID is required and was not set');
  const deptId = toVerifiedDeptId({ deptId: deptIdRaw });
  const client = createDynamoClient(process.env);
  const now = Math.floor(Date.now() / 1000);
  const cutoff = String(now - REDRIVE_AFTER_SECONDS).padStart(12, '0');
  let pending = 0;
  let stale = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND sk < :cutoff',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(deptId, 'CAD_UPDATE_PENDING'),
          ':cutoff': cutoff,
        },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of page.Items ?? []) {
      if (typeof item.dispatchId !== 'string' || typeof item.updateId !== 'string') continue;
      pending++;
      if (typeof item.receivedAt === 'number' && now - item.receivedAt > ALARM_AFTER_SECONDS) {
        stale++;
      }
      await notifyUpdate({ deptId, dispatchId: item.dispatchId, updateId: item.updateId });
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  if (pending > 0) emitCadMetric('CadUpdatePending', {});
  for (let i = 0; i < stale; i++) emitCadMetric('CadUpdateUnnotified', {});
  logInfo('cadIngress.updateSweep', { deptId, pending, stale });
  return { pending, stale };
};
