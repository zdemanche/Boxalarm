import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';
import type { NerisApi, NerisFailure } from '../../incident-service/neris/api.js';

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
  readonly status: 'CREATED' | 'UPDATED' | 'FAILED' | 'SKIPPED';
}

export interface EntitySyncRecord {
  readonly departmentNerisId: string;
  readonly stations: readonly SyncedStation[];
  readonly units: readonly SyncedUnit[];
  readonly errors: readonly { readonly subject: string; readonly message: string }[];
  readonly syncedAt: string;
  readonly syncedBy: string;
}

export async function getEntityRecord(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<EntitySyncRecord | undefined> {
  const result = await client.send(
    new GetCommand({ TableName: tableName, Key: { pk: buildDeptScopedPk(deptId), sk: ENTITY_SK } }),
  );
  return result.Item as EntitySyncRecord | undefined;
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
  previous: EntitySyncRecord | undefined,
  actorId: string,
  now: Date,
): Promise<EntitySyncRecord> {
  const knownStations = new Map(
    (previous?.stations ?? []).filter((s) => s.nerisId).map((s) => [s.stationId, s.nerisId!]),
  );
  const knownUnits = new Map(
    (previous?.units ?? []).filter((u) => u.nerisId).map((u) => [u.unitId, u.nerisId!]),
  );
  const stations: SyncedStation[] = [];
  const units: SyncedUnit[] = [];
  const errors: { subject: string; message: string }[] = [];

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
      const created = await api.createStation(departmentNerisId, body);
      if (created.ok) {
        stationNerisId = created.nerisId;
        stations.push({ stationId: station.stationId, nerisId: stationNerisId, status: 'CREATED' });
      } else {
        stations.push({ stationId: station.stationId, status: 'FAILED' });
        errors.push({ subject: `station ${station.stationId}`, message: describe(created) });
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
      const unitNerisId = knownUnits.get(unit.unitId);
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
  return {
    departmentNerisId,
    stations,
    units,
    errors,
    syncedAt: now.toISOString(),
    syncedBy: actorId,
  };
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
