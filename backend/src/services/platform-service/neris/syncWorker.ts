import type { Handler } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createLogger } from '@boxalarm/logging';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { getDynamoDocClient } from '../export/awsClients.js';
import { getDepartmentConfig } from '../config/repository.js';
import { createNerisApi } from '../../incident-service/neris/api.js';
import { getNerisClient, readNerisConfig } from '../../incident-service/neris/index.js';
import { getEntityRecord, markSyncFailed, saveEntityRecord, syncEntity } from './entitySync.js';

const logger = createLogger({ service: 'platform-service' });

export interface SyncJob {
  readonly deptId: string;
  readonly correlationId: string;
}

/**
 * Runs a NERIS entity sync that PUT /platform/neris/entity started (invoked asynchronously):
 * reads the pending request from the NERIS#ENTITY row, registers or patches each station
 * and unit, and saves the result with its neris.entity.synced event.
 */
export const handler: Handler<SyncJob, void> = async (job) => {
  const deptId = toVerifiedDeptId({ deptId: job.deptId });
  const tableName = process.env.PLATFORM_TABLE_NAME;
  if (!tableName) throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  const client = getDynamoDocClient();
  const row = await getEntityRecord(client, tableName, deptId);
  if (row?.syncStatus !== 'SYNCING' || !row.pendingRequest) {
    logger.warn({
      event: 'platform.neris.entity.nothing_pending',
      correlationId: job.correlationId,
      deptId,
    });
    return;
  }
  let record;
  try {
    const config = await getDepartmentConfig(client, { tableName, deptId, configType: 'NERIS' });
    const departmentNerisId = config?.value.departmentNerisId;
    if (typeof departmentNerisId !== 'string') {
      throw new Error('the department NERIS id is no longer configured');
    }
    const api = createNerisApi(getNerisClient(await readNerisConfig(process.env)));
    record = await syncEntity(
      api,
      departmentNerisId,
      row.pendingRequest,
      row,
      row.requestedBy ?? 'unknown',
      new Date(),
    );
    await saveEntityRecord(client, tableName, deptId, record, job.correlationId);
  } catch (error) {
    // Recorded as FAILED so GET says why at once instead of SYNCING until it goes stale
    // (round 2, N9); rethrown so the invoke's on-failure destination (and its alarm) see it.
    const message = error instanceof Error ? error.message : 'unknown error';
    logger.error({
      event: 'platform.neris.entity.sync_crashed',
      correlationId: job.correlationId,
      deptId,
      message,
    });
    emitOutcomeMetric('Boxalarm/platform-service', 'NerisEntitySyncFailed');
    await markSyncFailed(client, tableName, deptId, message, new Date()).catch(() => undefined);
    throw error;
  }
  logger.info({
    event: 'platform.neris.entity.synced',
    correlationId: job.correlationId,
    deptId,
    stations: record.stations.length,
    units: record.units.length,
    errors: record.errors.length,
  });
  emitOutcomeMetric(
    'Boxalarm/platform-service',
    record.errors.length > 0 ? 'NerisEntitySyncPartial' : 'NerisEntitySynced',
  );
};
