import { createHash } from 'node:crypto';
import type { Incident } from '../entity.js';
import { NERIS_INCIDENT_NUMBER_PATTERN } from './paths.js';
import { PAYLOAD_ROOT, deepPick, moduleNode, type CompiledNerisSchema } from './apiSchema.js';

/**
 * Builds the NERIS `IncidentPayload` (POST /incident/{entity}, /validate, and PUT by id)
 * from a Boxalarm incident. The spec sets `additionalProperties: false` on the payload,
 * `base`, `dispatch` and unit responses, so only allow-listed keys are ever emitted — an
 * unknown local field is dropped rather than turning the whole record into a 422.
 *
 * Sources, in precedence order (later wins):
 *   1. derived from the incident's own fields (dispatch number, alarm time, address,
 *      narrative, incident type) and its RESPONSE# unit rows;
 *   2. NERIS-shaped modules an editor stored on `corePayload` under their NERIS key
 *      (`base`, `dispatch`, `aids`, `fire_detail`, `smoke_alarm`, ...).
 *
 * The whole payload is then deep-picked to the NERIS schema compiled from the NERIS
 * OpenAPI document (neris/apiSchema.ts): every module, at every depth, keeps only the keys
 * its NERIS sub-schema declares, so a stray or nested local key (a name, a note) is never
 * transmitted.
 *
 * Fire-only guardrail (no PHI, ever — project decision on the review's M9):
 *   - `medical_details` is sent only when a MEDICAL incident type is present, and then only
 *     `patient_care_evaluation`, `patient_status` and `transport_disposition` — never
 *     `patient_care_report_id`.
 *   - `casualty_rescues` sends only the fields NERIS marks required, at every depth. The
 *     optional civilian demographics (birth month/year, gender, race) are never sent, and a
 *     name-like key is dropped wherever it appears ("Think Numbers NOT Names").
 */

/** Never sent at any depth of any module, whatever a schema version declares. */
export const NEVER_SENT_KEYS: ReadonlySet<string> = new Set([
  'birth_month_year',
  'gender',
  'race',
  'patient_care_report_id',
  'first_name',
  'last_name',
  'full_name',
  'patient_name',
  'date_of_birth',
  'dob',
  'ssn',
  'phone',
  'email',
]);

export type NerisPayload = Record<string, unknown>;

const PASS_THROUGH_MODULES = [
  'special_modifiers',
  'aids',
  'nonfd_aids',
  'actions_tactics',
  'tactic_timestamps',
  'exposures',
  'casualty_rescues',
  'fire_detail',
  'hazsit_detail',
  'smoke_alarm',
  'fire_alarm',
  'other_alarm',
  'fire_suppression',
  'cooking_fire_suppression',
  'electric_hazards',
  'powergen_hazards',
  'csst_hazard',
  'medical_oxygen_hazard',
] as const;

const BASE_KEYS = new Set([
  'people_present',
  'animals_rescued',
  'displacement_count',
  'department_neris_id',
  'incident_number',
  'person_experiencing_homelessness',
  'displacement_causes',
  'impediment_narrative',
  'outcome_narrative',
  'point',
  'polygon',
  'location',
  'location_use',
]);

const DISPATCH_KEYS = new Set([
  'center_id',
  'incident_number',
  'determinant_code',
  'incident_code',
  'automatic_alarm',
  'incident_clear',
  'call_arrival',
  'call_answered',
  'call_create',
  'disposition',
  'location',
  'point',
  'comments',
  'unit_responses',
  'tactic_timestamps',
]);

const UNIT_RESPONSE_KEYS = new Set([
  'unit_neris_id',
  'reported_unit_id',
  'staffing',
  'unable_to_dispatch',
  'dispatch',
  'enroute_to_scene',
  'on_scene',
  'canceled_enroute',
  'staging',
  'unit_clear',
  'point',
  'response_mode',
  'transport_mode',
]);

/** The only medical fields NERIS may receive from a fire-only system. */
const MEDICAL_KEYS = new Set([
  'patient_care_evaluation',
  'patient_status',
  'transport_disposition',
]);

export interface ResponseUnitRow {
  readonly unitId: string;
  readonly unitType?: string;
  readonly dispatchedAt?: number;
  readonly enRouteAt?: number;
  readonly arrivedAt?: number;
  readonly clearedAt?: number;
  readonly assignedPositions?: readonly unknown[];
}

export interface BuildPayloadInput {
  readonly incident: Incident;
  readonly units: readonly ResponseUnitRow[];
  readonly departmentNerisId: string;
  readonly unitNerisIds: Readonly<Record<string, string>>;
  /** The compiled NERIS payload schema every module is deep-picked to. */
  readonly schema: CompiledNerisSchema;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pick(source: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => keys.has(key) && value !== undefined),
  );
}

export function isoFromEpochSeconds(value: number | undefined): string | undefined {
  return value === undefined || !Number.isFinite(value)
    ? undefined
    : new Date(value * 1000).toISOString();
}

/** NERIS incident numbers match `[\w\-:]+`; anything else becomes `-`. */
export function toNerisIncidentNumber(value: string): string {
  const cleaned = value.trim().replace(/[^\w\-:]/g, '-');
  return NERIS_INCIDENT_NUMBER_PATTERN.test(cleaned) ? cleaned : 'UNKNOWN';
}

const ADDRESS_PATTERN =
  /^\s*(\d{1,7})\s+([^,]+?)\s*(?:,\s*([^,]+?)\s*)?(?:,\s*([A-Z]{2})(?:\s+(\d{5})(?:-\d{4})?)?\s*)?$/;

/**
 * A free-text address ("12 Main St, Trumbull, CT 06611") as a NERIS `LocationPayload`.
 * Anything that does not parse is sent as the street so nothing the officer typed is lost.
 */
export function locationFromAddress(address: string | undefined): Record<string, unknown> {
  if (!address || address.trim().length === 0) {
    return {};
  }
  const match = ADDRESS_PATTERN.exec(address);
  if (!match) {
    return { street: address.trim().slice(0, 255) };
  }
  const [, number, street, municipality, state, postalCode] = match;
  const parsedNumber = Number(number);
  return {
    ...(Number.isInteger(parsedNumber) && parsedNumber <= 1_000_000
      ? { number: parsedNumber }
      : { complete_number: number }),
    street: street!.slice(0, 255),
    ...(municipality ? { incorporated_municipality: municipality.slice(0, 255) } : {}),
    ...(state ? { state } : {}),
    ...(postalCode ? { postal_code: postalCode } : {}),
  };
}

function incidentTypes(incident: Incident): unknown[] {
  const stored = incident.corePayload.incident_types;
  if (Array.isArray(stored) && stored.length > 0) {
    return stored;
  }
  const type = incident.corePayload.incident_type ?? incident.incidentType;
  if (typeof type === 'string' && type.trim().length > 0) {
    return [{ type: type.trim(), primary: true }];
  }
  // NERIS's CAD-first value for a record whose type is not known yet; local validation
  // blocks lock on it, so it only ever reaches NERIS's /validate, never a create.
  return [{ type: 'UNDETERMINED' }];
}

export function hasIncidentCategory(types: readonly unknown[], category: string): boolean {
  return types.some((entry) => {
    const type = asRecord(entry)?.type;
    return typeof type === 'string' && type.split('||')[0] === category;
  });
}

function unitResponse(
  row: ResponseUnitRow,
  unitNerisIds: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const staffing = Array.isArray(row.assignedPositions) ? row.assignedPositions.length : undefined;
  const nerisId = unitNerisIds[row.unitId];
  const derived: Record<string, unknown> = {
    reported_unit_id: row.unitId,
    ...(nerisId ? { unit_neris_id: nerisId } : {}),
    ...(staffing !== undefined && staffing > 0 ? { staffing } : {}),
    dispatch: isoFromEpochSeconds(row.dispatchedAt),
    enroute_to_scene: isoFromEpochSeconds(row.enRouteAt),
    on_scene: isoFromEpochSeconds(row.arrivedAt),
    unit_clear: isoFromEpochSeconds(row.clearedAt),
  };
  return pick(derived, UNIT_RESPONSE_KEYS);
}

function sanitizeMedical(value: unknown, types: readonly unknown[]): unknown[] | undefined {
  if (!hasIncidentCategory(types, 'MEDICAL') || !Array.isArray(value)) {
    return undefined;
  }
  const cleaned = value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => pick(entry, MEDICAL_KEYS))
    .filter((entry) => Object.keys(entry).length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

export function buildNerisIncidentPayload(input: BuildPayloadInput): NerisPayload {
  const { incident } = input;
  const core = incident.corePayload;
  const types = incidentTypes(incident);
  const alarm = isoFromEpochSeconds(incident.alarmAt ?? incident.epochSeconds);
  const incidentNumber = toNerisIncidentNumber(incident.dispatchNumber);
  const location = {
    ...locationFromAddress(incident.address ?? (core.address as string | undefined)),
    ...(asRecord(core.location) ?? {}),
  };
  const narrative = incident.narrative ?? (core.narrative as string | undefined);
  const apparatus = input.units.filter((row) => row.unitType !== 'MEMBER');

  const storedBase = asRecord(core.base) ?? {};
  const base = pick(
    {
      ...(narrative && narrative.trim().length > 0 ? { outcome_narrative: narrative } : {}),
      ...storedBase,
      location: { ...location, ...(asRecord(storedBase.location) ?? {}) },
      department_neris_id: input.departmentNerisId,
      incident_number: incidentNumber,
    },
    BASE_KEYS,
  );

  const storedDispatch = asRecord(core.dispatch) ?? {};
  const derivedUnits = apparatus.map((row) => unitResponse(row, input.unitNerisIds));
  const storedUnits = Array.isArray(storedDispatch.unit_responses)
    ? storedDispatch.unit_responses
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== undefined)
        .map((entry) => pick(entry, UNIT_RESPONSE_KEYS))
    : undefined;
  const dispatch = pick(
    {
      call_arrival: alarm,
      call_answered: alarm,
      call_create: alarm,
      ...storedDispatch,
      incident_number: incidentNumber,
      location: { ...location, ...(asRecord(storedDispatch.location) ?? {}) },
      unit_responses: storedUnits ?? derivedUnits,
    },
    DISPATCH_KEYS,
  );

  const payload: NerisPayload = { base, incident_types: types, dispatch };
  for (const key of PASS_THROUGH_MODULES) {
    const value = core[key];
    if (value !== undefined && value !== null && typeof value === 'object') {
      payload[key] = value;
    }
  }
  const medical = sanitizeMedical(core.medical_details, types);
  if (medical) {
    payload.medical_details = medical;
  }
  const casualtyNode = moduleNode(input.schema, 'casualty_rescues');
  if (payload.casualty_rescues !== undefined && casualtyNode) {
    const casualties = deepPick(input.schema, casualtyNode, payload.casualty_rescues, {
      requiredOnly: true,
      denyKeys: NEVER_SENT_KEYS,
    });
    if (Array.isArray(casualties) && casualties.length > 0) {
      payload.casualty_rescues = casualties;
    } else {
      delete payload.casualty_rescues;
    }
  }
  return (deepPick(input.schema, { k: 'ref', n: PAYLOAD_ROOT }, payload, {
    denyKeys: NEVER_SENT_KEYS,
  }) ?? {}) as NerisPayload;
}

/** Key-order-independent JSON, so the same record always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function payloadHash(payload: NerisPayload): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export interface PayloadChange {
  readonly path: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

const MAX_DIFF_ENTRIES = 200;

/** Leaf-level differences between two payloads (arrays compared element-wise). */
export function diffPayloads(before: unknown, after: unknown, path = ''): PayloadChange[] {
  const changes: PayloadChange[] = [];
  const walk = (a: unknown, b: unknown, at: string): void => {
    if (changes.length >= MAX_DIFF_ENTRIES) return;
    const ra = asRecord(a);
    const rb = asRecord(b);
    if (ra && rb) {
      for (const key of [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort()) {
        walk(ra[key], rb[key], at ? `${at}.${key}` : key);
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        walk(a[i], b[i], `${at}[${i}]`);
      }
      return;
    }
    if (canonicalJson(a) !== canonicalJson(b)) {
      changes.push({
        path: at,
        ...(a !== undefined ? { before: a } : {}),
        ...(b !== undefined ? { after: b } : {}),
      });
    }
  };
  walk(before, after, path);
  return changes;
}
