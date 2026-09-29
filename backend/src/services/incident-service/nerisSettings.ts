import { PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { DEFAULT_TIME_ZONE, isTimeZone } from './neris/zonedTime.js';

/**
 * incident-service's copy of the department's NERIS settings. platform-service owns them
 * (the `NERIS` department config and the NERIS entity sync); this service holds no grant on
 * the platform table, so the copy is projected from `platform.config.updated` and
 * `neris.entity.synced` by nerisSettingsConsumer.ts — the dispatch-projection pattern.
 *
 * Rows: pk DEPT#{deptId}#NERIS, sk SETTINGS (config) and sk ENTITY (station/unit ids).
 */

export interface NerisDepartmentRules {
  /** Require an outcome narrative before lock (default true). */
  readonly requireNarrative: boolean;
  /** Minimum narrative length when required (default 0 = any non-empty text). */
  readonly minNarrativeLength: number;
  /** Require dispatch, on-scene and clear times on every responding apparatus (default true). */
  readonly requireUnitTimes: boolean;
}

export interface NerisDeptSettings {
  /** The department's NERIS entity id (`FD` + 8 digits); absent until an admin sets it. */
  readonly departmentNerisId?: string;
  /** Lock queues the NERIS submission straight away (ESO parity; default false). */
  readonly autoSubmitOnLock: boolean;
  /** Kill switch: when false nothing is sent to NERIS (default true). */
  readonly submissionsEnabled: boolean;
  readonly rules: NerisDepartmentRules;
  /** IANA zone months are counted in (no-activity reports); default America/New_York. */
  readonly timeZone: string;
  /** Boxalarm unitId -> NERIS unit id, from the last entity sync. */
  readonly unitNerisIds: Readonly<Record<string, string>>;
  readonly entitySyncedAt?: string;
}

export const DEFAULT_RULES: NerisDepartmentRules = {
  requireNarrative: true,
  minNarrativeLength: 0,
  requireUnitTimes: true,
};

export const DEFAULT_NERIS_SETTINGS: NerisDeptSettings = {
  autoSubmitOnLock: false,
  submissionsEnabled: true,
  rules: DEFAULT_RULES,
  timeZone: DEFAULT_TIME_ZONE,
  unitNerisIds: {},
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseRules(value: unknown): NerisDepartmentRules {
  const raw = asRecord(value) ?? {};
  return {
    requireNarrative:
      typeof raw.requireNarrative === 'boolean'
        ? raw.requireNarrative
        : DEFAULT_RULES.requireNarrative,
    minNarrativeLength:
      typeof raw.minNarrativeLength === 'number' &&
      Number.isInteger(raw.minNarrativeLength) &&
      raw.minNarrativeLength >= 0
        ? raw.minNarrativeLength
        : DEFAULT_RULES.minNarrativeLength,
    requireUnitTimes:
      typeof raw.requireUnitTimes === 'boolean'
        ? raw.requireUnitTimes
        : DEFAULT_RULES.requireUnitTimes,
  };
}

export async function getNerisDeptSettings(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<NerisDeptSettings> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': buildDeptScopedPk(deptId, 'NERIS') },
    }),
  );
  const items = (result.Items ?? []) as Record<string, unknown>[];
  const settings = items.find((item) => item.sk === 'SETTINGS');
  const entity = items.find((item) => item.sk === 'ENTITY');
  const unitNerisIds: Record<string, string> = {};
  for (const unit of Array.isArray(entity?.units) ? entity.units : []) {
    const record = asRecord(unit);
    if (typeof record?.unitId === 'string' && typeof record.nerisId === 'string') {
      unitNerisIds[record.unitId] = record.nerisId;
    }
  }
  const departmentNerisId =
    typeof settings?.departmentNerisId === 'string'
      ? settings.departmentNerisId
      : typeof entity?.departmentNerisId === 'string'
        ? entity.departmentNerisId
        : undefined;
  return {
    ...(departmentNerisId ? { departmentNerisId } : {}),
    autoSubmitOnLock: settings?.autoSubmitOnLock === true,
    submissionsEnabled: settings?.submissionsEnabled !== false,
    rules: parseRules(settings?.rules),
    timeZone: isTimeZone(settings?.timeZone) ? settings.timeZone : DEFAULT_TIME_ZONE,
    unitNerisIds,
    ...(typeof entity?.syncedAt === 'string' ? { entitySyncedAt: entity.syncedAt } : {}),
  };
}

export interface NerisSettingsProjection {
  readonly departmentNerisId?: string;
  readonly autoSubmitOnLock: boolean;
  readonly submissionsEnabled: boolean;
  readonly rules: NerisDepartmentRules;
  readonly timeZone?: string;
  readonly version: number;
}

export interface NerisEntityProjection {
  readonly departmentNerisId: string;
  readonly units: readonly { readonly unitId: string; readonly nerisId: string }[];
  readonly syncedAt: string;
}

/**
 * Last-writer-wins by source version: an out-of-order redelivery of an older config version
 * never overwrites a newer one.
 */
export async function putNerisSettingsProjection(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  projection: NerisSettingsProjection,
): Promise<'applied' | 'stale'> {
  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: buildDeptScopedPk(deptId, 'NERIS'),
          sk: 'SETTINGS',
          entityType: 'NERIS_SETTINGS_COPY',
          ...projection,
        },
        ConditionExpression: 'attribute_not_exists(pk) OR #version < :version',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':version': projection.version },
      }),
    );
    return 'applied';
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return 'stale';
    }
    throw error;
  }
}

export async function putNerisEntityProjection(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  projection: NerisEntityProjection,
): Promise<'applied' | 'stale'> {
  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: buildDeptScopedPk(deptId, 'NERIS'),
          sk: 'ENTITY',
          entityType: 'NERIS_ENTITY_COPY',
          ...projection,
        },
        ConditionExpression: 'attribute_not_exists(pk) OR syncedAt < :syncedAt',
        ExpressionAttributeValues: { ':syncedAt': projection.syncedAt },
      }),
    );
    return 'applied';
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return 'stale';
    }
    throw error;
  }
}
