import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';
import type {
  NerisApi,
  NerisEntityStation,
  NerisFailure,
} from '../../incident-service/neris/api.js';

/**
 * NERIS entity sync: registers the department's stations and units with its NERIS entity
 * (POST /entity/{entity}/station, POST .../station/{station}/unit; PATCH once they exist)
 * so every unit response can carry a `unit_neris_id`. The returned NERIS ids live on one
 * platform-table row (sk NERIS#ENTITY) and go out as `neris.entity.synced`, which
 * incident-service projects for its payload builder.
 */

/** NERIS `TypeUnitValue` (OpenAPI v1.4.78 / v1.5.1). */
export const NERIS_UNIT_TYPES = [
  'AIR_EMS',
  'AIR_LIGHT',
  'AIR_RECON',
  'AIR_TANKER',
  'ALS_AMB',
  'ARFF',
  'ATV_EMS',
  'ATV_FIRE',
  'BLS_AMB',
  'BOAT',
  'BOAT_LARGE',
  'CHIEF_STAFF_COMMAND',
  'CREW',
  'CREW_TRANS',
  'DECON',
  'DOZER',
  'EMS_NOTRANS',
  'EMS_SUPV',
  'ENGINE_STRUCT',
  'ENGINE_WUI',
  'FOAM',
  'HAZMAT',
  'HELO_FIRE',
  'HELO_GENERAL',
  'HELO_RESCUE',
  'INVEST',
  'LADDER_QUINT',
  'LADDER_SMALL',
  'LADDER_TALL',
  'LADDER_TILLER',
  'MAB',
  'MOBILE_COMMS',
  'MOBILE_ICP',
  'OTHER_GROUND',
  'PLATFORM',
  'PLATFORM_QUINT',
  'POV',
  'QUINT_TALL',
  'REHAB',
  'RESCUE_HEAVY',
  'RESCUE_LIGHT',
  'RESCUE_MEDIUM',
  'RESCUE_USAR',
  'RESCUE_WATER',
  'SCBA',
  'TENDER',
  'UAS_FIRE',
  'UAS_RECON',
  'UTIL',
] as const;

export const ENTITY_SK = 'NERIS#ENTITY';
const CAD_DESIGNATION = /^[\w()#\- ]{1,64}$/;

export interface UnitInput {
  readonly unitId: string;
  readonly type: string;
  readonly staffing: number;
  readonly dedicatedStaffing?: boolean;
}

export interface StationInput {
  readonly stationId: string;
  readonly addressLine1: string;
  readonly city: string;
  readonly state: string;
  readonly zipCode: string;
  readonly units: readonly UnitInput[];
}

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseSyncRequest(body: unknown): { stations: StationInput[] } | FieldError[] {
  if (!isRecord(body) || !Array.isArray(body.stations) || body.stations.length === 0) {
    return [{ field: 'stations', message: 'is required and must be a non-empty array' }];
  }
  const errors: FieldError[] = [];
  const unitIds = new Set<string>();
  const stations: StationInput[] = [];
  body.stations.forEach((raw, i) => {
    const at = `stations[${i}]`;
    if (!isRecord(raw)) {
      errors.push({ field: at, message: 'must be an object' });
      return;
    }
    for (const field of ['stationId', 'addressLine1', 'city'] as const) {
      if (!nonEmpty(raw[field])) errors.push({ field: `${at}.${field}`, message: 'is required' });
    }
    if (typeof raw.state !== 'string' || !/^[A-Z]{2}$/.test(raw.state)) {
      errors.push({ field: `${at}.state`, message: 'must be the two-letter state code' });
    }
    if (typeof raw.zipCode !== 'string' || !/^\d{5}(-\d{4})?$/.test(raw.zipCode)) {
      errors.push({ field: `${at}.zipCode`, message: 'must be a 5-digit ZIP code' });
    }
    const units: UnitInput[] = [];
    (Array.isArray(raw.units) ? raw.units : []).forEach((unit, j) => {
      const uat = `${at}.units[${j}]`;
      if (!isRecord(unit)) {
        errors.push({ field: uat, message: 'must be an object' });
        return;
      }
      if (typeof unit.unitId !== 'string' || !CAD_DESIGNATION.test(unit.unitId)) {
        errors.push({
          field: `${uat}.unitId`,
          message: 'must be the CAD designation (letters, digits, space, - # ( ))',
        });
      } else if (unitIds.has(unit.unitId)) {
        errors.push({ field: `${uat}.unitId`, message: 'is listed twice' });
      } else {
        unitIds.add(unit.unitId);
      }
      if (
        typeof unit.type !== 'string' ||
        !(NERIS_UNIT_TYPES as readonly string[]).includes(unit.type)
      ) {
        errors.push({
          field: `${uat}.type`,
          message: 'must be a NERIS unit type, e.g. ENGINE_STRUCT',
        });
      }
      if (
        typeof unit.staffing !== 'number' ||
        !Number.isInteger(unit.staffing) ||
        unit.staffing < 0
      ) {
        errors.push({ field: `${uat}.staffing`, message: 'must be a whole number of seats' });
      }
      if (unit.dedicatedStaffing !== undefined && typeof unit.dedicatedStaffing !== 'boolean') {
        errors.push({ field: `${uat}.dedicatedStaffing`, message: 'must be a boolean' });
      }
      units.push({
        unitId: String(unit.unitId),
        type: String(unit.type),
        staffing: Number(unit.staffing),
        ...(typeof unit.dedicatedStaffing === 'boolean'
          ? { dedicatedStaffing: unit.dedicatedStaffing }
          : {}),
      });
    });
    stations.push({
      stationId: String(raw.stationId),
      addressLine1: String(raw.addressLine1),
      city: String(raw.city),
      state: String(raw.state),
      zipCode: String(raw.zipCode),
      units,
    });
  });
  return errors.length > 0 ? errors : { stations };
}

export interface SyncedStation {
  readonly stationId: string;
  readonly nerisId?: string;
  readonly status: 'CREATED' | 'UPDATED' | 'FAILED';
}

export interface SyncedUnit {
  readonly unitId: string;
  readonly stationId: string;
  readonly nerisId?: string;
  /** RETAINED: registered by an earlier sync and not in this request; its NERIS id is kept. */
  readonly status: 'CREATED' | 'UPDATED' | 'FAILED' | 'SKIPPED' | 'RETAINED';
}

export interface EntitySyncRecord {
  readonly departmentNerisId: string;
  readonly stations: readonly SyncedStation[];
  readonly units: readonly SyncedUnit[];
  readonly errors: readonly { readonly subject: string; readonly message: string }[];
  readonly syncedAt: string;
  readonly syncedBy: string;
}

/** The stored row: the last completed sync, plus a sync that is running now, if any. */
export interface EntitySyncRow extends Partial<EntitySyncRecord> {
  /** FAILED: the worker could not run or crashed (`syncError`); the last result is kept. */
  readonly syncStatus?: 'SYNCING' | 'SYNCED' | 'PARTIAL' | 'FAILED';
  readonly syncError?: string;
  readonly syncFailedAt?: string;
  readonly pendingRequest?: { readonly stations: readonly StationInput[] };
  readonly syncStartedAt?: string;
  readonly requestedBy?: string;
}

/**
 * A SYNCING row older than this was abandoned: the worker's Lambda timeout is 300 s and its
 * async invoke has no retries, so nothing can still be running after 6 minutes. GET then
 * reports it FAILED and PUT may start a new sync (round 2b, R6: a timed-out worker never
 * reaches its own catch).
 */
export const SYNC_STALE_MS = 6 * 60 * 1000;

/** True for a SYNCING row whose worker can no longer be running (timed out or lost). */
export function isAbandonedSync(row: EntitySyncRow | undefined, now: Date): boolean {
  if (row?.syncStatus !== 'SYNCING' || !row.syncStartedAt) return false;
  const started = Date.parse(row.syncStartedAt);
  return Number.isFinite(started) && now.getTime() - started > SYNC_STALE_MS;
}

export async function getEntityRecord(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<EntitySyncRow | undefined> {
  const result = await client.send(
    new GetCommand({ TableName: tableName, Key: { pk: buildDeptScopedPk(deptId), sk: ENTITY_SK } }),
  );
  return result.Item as EntitySyncRow | undefined;
}

function describe(failure: NerisFailure): string {
  const issue = failure.issues[0];
  return issue
    ? `NERIS refused it (HTTP ${failure.httpStatus}): ${issue.path ? `${issue.path}: ` : ''}${issue.message}`
    : `NERIS answered HTTP ${failure.httpStatus}`;
}

export async function syncEntity(
  api: NerisApi,
  departmentNerisId: string,
  request: { readonly stations: readonly StationInput[] },
  previous: EntitySyncRow | undefined,
  actorId: string,
  now: Date,
): Promise<EntitySyncRecord> {
  // Ids from an earlier sync are only reused under the same NERIS entity: after the
  // department id changes they name another entity's stations and units (review minor 8).
  const sameEntity = previous?.departmentNerisId === departmentNerisId;
  const previousStations = sameEntity ? (previous?.stations ?? []) : [];
  const previousUnits = sameEntity ? (previous?.units ?? []) : [];
  const knownStations = new Map(
    previousStations.filter((s) => s.nerisId).map((s) => [s.stationId, s.nerisId!]),
  );
  const knownUnits = new Map(
    previousUnits.filter((u) => u.nerisId).map((u) => [u.unitId, u.nerisId!]),
  );
  const stations: SyncedStation[] = [];
  const units: SyncedUnit[] = [];
  const errors: { subject: string; message: string }[] = [];

  // Idempotent create (round 2, N9): before registering a station or unit we have no id for,
  // look for one NERIS already holds under our station id / CAD designation — a sync that
  // crashed after a create but before saving its id must not register it twice. Read once,
  // and only when something would otherwise be created.
  let existing: readonly NerisEntityStation[] | undefined | 'unavailable';
  const lookup = async (): Promise<readonly NerisEntityStation[] | 'unavailable'> => {
    if (existing === undefined) {
      const found = await api.getEntity(departmentNerisId);
      existing = found.ok ? found.stations : 'unavailable';
      if (!found.ok) {
        errors.push({
          subject: 'NERIS entity',
          message: `Couldn't check what NERIS already holds, so nothing new was registered (${describe(found)}). Try the sync again.`,
        });
      }
    }
    return existing;
  };

  for (const station of request.stations) {
    const body = {
      station_id: station.stationId,
      address_line_1: station.addressLine1,
      city: station.city,
      state: station.state,
      zip_code: station.zipCode,
    };
    let stationNerisId = knownStations.get(station.stationId);
    if (stationNerisId) {
      const patched = await api.patchStation(departmentNerisId, stationNerisId, body);
      stations.push({
        stationId: station.stationId,
        nerisId: stationNerisId,
        status: patched.ok ? 'UPDATED' : 'FAILED',
      });
      if (!patched.ok)
        errors.push({ subject: `station ${station.stationId}`, message: describe(patched) });
    } else {
      const held = await lookup();
      const match =
        held === 'unavailable' ? undefined : held.find((s) => s.stationId === station.stationId);
      if (held === 'unavailable') {
        stations.push({ stationId: station.stationId, status: 'FAILED' });
      } else if (match) {
        stationNerisId = match.nerisId;
        const patched = await api.patchStation(departmentNerisId, stationNerisId, body);
        stations.push({
          stationId: station.stationId,
          nerisId: stationNerisId,
          status: patched.ok ? 'UPDATED' : 'FAILED',
        });
        if (!patched.ok)
          errors.push({ subject: `station ${station.stationId}`, message: describe(patched) });
      } else {
        const created = await api.createStation(departmentNerisId, body);
        if (created.ok) {
          stationNerisId = created.nerisId;
          stations.push({
            stationId: station.stationId,
            nerisId: stationNerisId,
            status: 'CREATED',
          });
        } else {
          stations.push({ stationId: station.stationId, status: 'FAILED' });
          errors.push({ subject: `station ${station.stationId}`, message: describe(created) });
        }
      }
    }

    for (const unit of station.units) {
      if (!stationNerisId) {
        units.push({ unitId: unit.unitId, stationId: station.stationId, status: 'SKIPPED' });
        continue;
      }
      const unitBody = {
        type: unit.type,
        staffing: unit.staffing,
        cad_designation_1: unit.unitId,
        ...(unit.dedicatedStaffing !== undefined
          ? { dedicated_staffing: unit.dedicatedStaffing }
          : {}),
      };
      let unitNerisId = knownUnits.get(unit.unitId);
      if (!unitNerisId) {
        const held = await lookup();
        if (held === 'unavailable') {
          units.push({ unitId: unit.unitId, stationId: station.stationId, status: 'FAILED' });
          continue;
        }
        unitNerisId = held
          .find((s) => s.nerisId === stationNerisId)
          ?.units.find((u) => u.cadDesignation === unit.unitId)?.nerisId;
      }
      if (unitNerisId) {
        const patched = await api.patchUnit(
          departmentNerisId,
          stationNerisId,
          unitNerisId,
          unitBody,
        );
        units.push({
          unitId: unit.unitId,
          stationId: station.stationId,
          nerisId: unitNerisId,
          status: patched.ok ? 'UPDATED' : 'FAILED',
        });
        if (!patched.ok)
          errors.push({ subject: `unit ${unit.unitId}`, message: describe(patched) });
      } else {
        const created = await api.createUnit(departmentNerisId, stationNerisId, unitBody);
        if (created.ok) {
          units.push({
            unitId: unit.unitId,
            stationId: station.stationId,
            nerisId: created.nerisId,
            status: 'CREATED',
          });
        } else {
          units.push({ unitId: unit.unitId, stationId: station.stationId, status: 'FAILED' });
          errors.push({ subject: `unit ${unit.unitId}`, message: describe(created) });
        }
      }
    }
  }
  // A unit left out of this request keeps the NERIS id it already has: dropping it would
  // make re-adding it create a duplicate NERIS unit.
  const requested = new Set(units.map((u) => u.unitId));
  const retained: SyncedUnit[] = previousUnits
    .filter((u) => u.nerisId && !requested.has(u.unitId))
    .map((u) => ({ ...u, status: 'RETAINED' as const }));
  const requestedStations = new Set(stations.map((s) => s.stationId));
  const retainedStations = previousStations.filter(
    (s) => s.nerisId && !requestedStations.has(s.stationId),
  );
  return {
    departmentNerisId,
    stations: [...stations, ...retainedStations],
    units: [...units, ...retained],
    errors,
    syncedAt: now.toISOString(),
    syncedBy: actorId,
  };
}

/**
 * Starts a sync: records the request as SYNCING unless one is already running (and not
 * abandoned). The worker (syncWorker.ts) then makes the NERIS calls asynchronously — one per
 * station and unit can outlast API Gateway's 30 s limit (review minor 8).
 */
export async function markSyncing(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  request: { readonly stations: readonly StationInput[] },
  actorId: string,
  now: Date,
): Promise<'started' | 'already_running'> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(deptId), sk: ENTITY_SK },
        ConditionExpression:
          'attribute_not_exists(syncStatus) OR syncStatus <> :syncing OR syncStartedAt < :staleBefore',
        UpdateExpression:
          'SET entityType = :type, syncStatus = :syncing, pendingRequest = :request, syncStartedAt = :now, requestedBy = :actor',
        ExpressionAttributeValues: {
          ':type': 'NERIS_ENTITY_SYNC',
          ':syncing': 'SYNCING',
          ':request': request,
          ':now': now.toISOString(),
          ':actor': actorId,
          ':staleBefore': new Date(now.getTime() - SYNC_STALE_MS).toISOString(),
        },
      }),
    );
    return 'started';
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return 'already_running';
    }
    throw error;
  }
}

/**
 * The sync could not run (the worker invoke failed, or the worker crashed): the row leaves
 * SYNCING at once, keeping the last completed result, with the reason GET reports. Only a
 * row still SYNCING is touched — a sync that finished in between wins.
 */
export async function markSyncFailed(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  message: string,
  now: Date,
): Promise<void> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(deptId), sk: ENTITY_SK },
        ConditionExpression: 'syncStatus = :syncing',
        UpdateExpression:
          'SET syncStatus = :failed, syncError = :message, syncFailedAt = :now REMOVE pendingRequest',
        ExpressionAttributeValues: {
          ':syncing': 'SYNCING',
          ':failed': 'FAILED',
          ':message': message.slice(0, 500),
          ':now': now.toISOString(),
        },
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return;
    throw error;
  }
}

export async function saveEntityRecord(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  record: EntitySyncRecord,
  correlationId: string,
): Promise<void> {
  await client.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: buildDeptScopedPk(deptId),
              sk: ENTITY_SK,
              entityType: 'NERIS_ENTITY_SYNC',
              ...record,
              syncStatus: record.errors.length > 0 ? 'PARTIAL' : 'SYNCED',
            },
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: buildOutboxRecord(
              deptId,
              'platform-service',
              'neris.entity.synced',
              correlationId,
              {
                deptId,
                departmentNerisId: record.departmentNerisId,
                syncedAt: record.syncedAt,
                units: record.units
                  .filter((u) => u.nerisId)
                  .map((u) => ({ unitId: u.unitId, stationId: u.stationId, nerisId: u.nerisId })),
                errorCount: record.errors.length,
              },
            ),
          },
        },
      ],
    }),
  );
}
