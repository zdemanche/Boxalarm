import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createLogger } from '@boxalarm/logging';
import { getDynamoDocClient } from '../export/awsClients.js';
import { getEntityRecord, isAbandonedSync } from './entitySync.js';

const logger = createLogger({ service: 'platform-service' });

/**
 * GET /api/v1/platform/neris/entity — the last station/unit sync (SYNCING, SYNCED, PARTIAL, or
 * FAILED with `syncError` when the sync could not run), or `{status: 'NOT_SYNCED'}`.
 */
async function inner(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const deptId = toVerifiedDeptId(principal);
  try {
    const tableName = process.env.PLATFORM_TABLE_NAME;
    if (!tableName) throw new Error('PLATFORM_TABLE_NAME is required and was not set');
    const stored = await getEntityRecord(getDynamoDocClient(), tableName, deptId);
    // A worker that timed out never records FAILED itself: past the worker's lifetime the
    // SYNCING row is reported as the failure it is.
    const record = isAbandonedSync(stored, new Date())
      ? {
          ...stored,
          syncStatus: 'FAILED' as const,
          syncError: "The sync didn't finish (it timed out). Try it again.",
        }
      : stored;
    const body =
      record?.syncStatus === 'SYNCING'
        ? {
            status: 'SYNCING',
            syncStartedAt: record.syncStartedAt ?? null,
            departmentNerisId: record.departmentNerisId ?? null,
            stations: record.stations ?? [],
            units: record.units ?? [],
            errors: record.errors ?? [],
          }
        : record?.syncStatus === 'FAILED'
          ? {
              status: 'FAILED',
              syncError: record.syncError ?? null,
              syncFailedAt: record.syncFailedAt ?? null,
              departmentNerisId: record.departmentNerisId ?? null,
              stations: record.stations ?? [],
              units: record.units ?? [],
              errors: record.errors ?? [],
              ...(record.syncedAt ? { syncedAt: record.syncedAt, syncedBy: record.syncedBy } : {}),
            }
          : record?.syncedAt
            ? {
                status: (record.errors ?? []).length > 0 ? 'PARTIAL' : 'SYNCED',
                departmentNerisId: record.departmentNerisId,
                stations: record.stations ?? [],
                units: record.units ?? [],
                errors: record.errors ?? [],
                syncedAt: record.syncedAt,
                syncedBy: record.syncedBy,
              }
            : { status: 'NOT_SYNCED', stations: [], units: [], errors: [] };
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  } catch (error) {
    logger.error({
      event: 'platform.neris.entity.get_failed',
      correlationId: traceId,
      deptId,
      message: error instanceof Error ? error.message : 'unknown error',
    });
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(inner, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewNerisEntity',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
