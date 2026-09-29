import type {
  Handler,
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { getDocumentClient, getTableName } from './repository.js';
import {
  parseRules,
  putNerisEntityProjection,
  putNerisSettingsProjection,
} from './nerisSettings.js';

const METRIC_NAMESPACE = 'Boxalarm/incident-neris-settings-copy';

/**
 * Keeps incident-service's copy of the department's NERIS settings (nerisSettings.ts) in
 * step with platform-service, which owns them:
 *   - `platform.config.updated` with configType NERIS -> the SETTINGS row
 *     (department NERIS id, autoSubmitOnLock, submissionsEnabled, rules);
 *   - `neris.entity.synced` -> the ENTITY row (unit NERIS ids for unit responses).
 * Any other config type is acknowledged and ignored (the rule filters on NERIS too).
 */

type ParsedEvent =
  | {
      readonly kind: 'settings';
      readonly deptId: string;
      readonly version: number;
      readonly value: Record<string, unknown>;
    }
  | {
      readonly kind: 'entity';
      readonly deptId: string;
      readonly departmentNerisId: string;
      readonly units: readonly { unitId: string; nerisId: string }[];
      readonly syncedAt: string;
    }
  | { readonly kind: 'ignored' };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseSettingsEvent(body: string): ParsedEvent {
  const detail = asRecord((JSON.parse(body) as { detail?: unknown }).detail);
  const eventType = detail?.eventType;
  const payload = asRecord(detail?.payload);
  if (!payload || typeof payload.deptId !== 'string') {
    throw new Error('NERIS settings event failed shape validation');
  }
  if (eventType === 'platform.config.updated') {
    if (payload.configType !== 'NERIS') {
      return { kind: 'ignored' };
    }
    const value = asRecord(payload.value);
    if (!value || typeof payload.version !== 'number') {
      throw new Error('platform.config.updated NERIS payload failed shape validation');
    }
    return { kind: 'settings', deptId: payload.deptId, version: payload.version, value };
  }
  if (eventType === 'neris.entity.synced') {
    if (
      typeof payload.departmentNerisId !== 'string' ||
      typeof payload.syncedAt !== 'string' ||
      !Array.isArray(payload.units)
    ) {
      throw new Error('neris.entity.synced payload failed shape validation');
    }
    const units = payload.units.flatMap((unit) => {
      const record = asRecord(unit);
      return typeof record?.unitId === 'string' && typeof record.nerisId === 'string'
        ? [{ unitId: record.unitId, nerisId: record.nerisId }]
        : [];
    });
    return {
      kind: 'entity',
      deptId: payload.deptId,
      departmentNerisId: payload.departmentNerisId,
      units,
      syncedAt: payload.syncedAt,
    };
  }
  throw new Error(`unsupported event type ${String(eventType)}`);
}

function logError(event: string, error: unknown, context: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      event,
      service: 'incident-service',
      ...context,
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
    }),
  );
}

interface Deps {
  readonly client?: DynamoDBDocumentClient;
}

async function processRecord(record: SQSRecord, deps: Deps): Promise<void> {
  let parsed: ParsedEvent;
  try {
    parsed = parseSettingsEvent(record.body);
  } catch (error) {
    logError('incident.nerisSettingsCopy.malformed', error, { correlationId: record.messageId });
    throw error;
  }
  if (parsed.kind === 'ignored') {
    return;
  }
  const client = deps.client ?? getDocumentClient();
  const tableName = getTableName(process.env);
  const deptId = toVerifiedDeptId({ deptId: parsed.deptId });
  try {
    const outcome =
      parsed.kind === 'settings'
        ? await putNerisSettingsProjection(client, tableName, deptId, {
            ...(typeof parsed.value.departmentNerisId === 'string'
              ? { departmentNerisId: parsed.value.departmentNerisId }
              : {}),
            autoSubmitOnLock: parsed.value.autoSubmitOnLock === true,
            submissionsEnabled: parsed.value.submissionsEnabled !== false,
            rules: parseRules(parsed.value.rules),
            ...(typeof parsed.value.timeZone === 'string'
              ? { timeZone: parsed.value.timeZone }
              : {}),
            version: parsed.version,
          })
        : await putNerisEntityProjection(client, tableName, deptId, {
            departmentNerisId: parsed.departmentNerisId,
            units: parsed.units,
            syncedAt: parsed.syncedAt,
          });
    emitOutcomeMetric(
      METRIC_NAMESPACE,
      outcome === 'applied' ? 'NerisSettingsCopyUpdated' : 'NerisSettingsCopyStale',
    );
  } catch (error) {
    logError('incident.nerisSettingsCopy.writeFailed', error, {
      correlationId: record.messageId,
      deptId,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'NerisSettingsCopyFailed');
    throw error;
  }
}

export function createHandler(deps: Deps = {}): Handler<SQSEvent, SQSBatchResponse> {
  return async (event) => {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    for (const record of event.Records) {
      try {
        await processRecord(record, deps);
      } catch {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}

export const handler = createHandler();
