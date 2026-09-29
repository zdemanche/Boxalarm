import type { Incident } from './entity.js';
import type { NerisSchemaDocument } from './schemaVersion/entity.js';
import type { NerisDeptSettings } from './nerisSettings.js';
import type { NerisApi, NerisIssue } from './neris/api.js';
import { incidentTypeLabel, type CompiledNerisSchema } from './neris/apiSchema.js';
import {
  buildNerisIncidentPayload,
  hasIncidentCategory,
  type NerisPayload,
  type ResponseUnitRow,
} from './neris/payload.js';

/**
 * "What's blocking lock": the checks a report must pass before an officer can lock it, in
 * fire-service language, each with the fix where the answer can be worked out.
 *
 * Three sources, merged:
 *   1. local NERIS rules — the cached schema pin (requiredFields + enumerations, refreshed
 *      daily by schemaVersion/refreshScanner) plus the structural rules of the NERIS
 *      OpenAPI and minimum-data FAQ (call and unit times in order, conditional modules);
 *   2. the department's own rules (NERIS platform config `rules`);
 *   3. NERIS itself: POST /incident/{entity}/validate (204 valid / 422 issues).
 *
 * A fix is `{label, path, value}` where `path` names what to change:
 *   `fields.<name>`             -> PUT /incidents/{id} {fields: {<name>: value}}
 *   `units.<unitId>.<timeField>` -> PUT /incidents/{id}/response-times {unitId, <timeField>: value}
 *   `narrative`                  -> PUT /incidents/{id}/narrative {narrative: value}
 */

export type ValidationMode = 'local' | 'neris' | 'both';

export const VALIDATION_MODES: readonly ValidationMode[] = ['local', 'neris', 'both'];

export type ValidationSection = 'core' | 'dispatch' | 'units' | 'narrative' | 'fire' | 'neris';

export interface ValidationFix {
  readonly label: string;
  readonly path: string;
  readonly value: string | number;
}

export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
  readonly section: ValidationSection;
  readonly fix?: ValidationFix;
}

export interface ValidationReport {
  readonly blocking: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
  /** ISO time NERIS answered 204 to this exact payload, or null when it was not asked / said no. */
  readonly nerisValidatedAt: string | null;
  readonly sectionsComplete: Readonly<Partial<Record<ValidationSection, boolean>>>;
}

export interface LocalValidationInput {
  readonly incident: Incident;
  readonly units: readonly ResponseUnitRow[];
  readonly settings: NerisDeptSettings;
  readonly schema?: NerisSchemaDocument;
  /** Compiled NERIS payload schema: its TypeIncidentValue list is the only valid type list. */
  readonly nerisApi?: CompiledNerisSchema;
  readonly nowEpochSeconds: number;
}

/**
 * NERIS types a non-NERIS value (a legacy local code or a CAD string) plausibly means: those
 * with a segment equal to it (`STRUCTURE_FIRE` -> the four `FIRE||STRUCTURE_FIRE||*`), else
 * those whose last segment contains it.
 */
export function suggestNerisTypes(value: string, nerisTypes: readonly string[]): string[] {
  const token = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
  if (!token) return [];
  const bySegment = nerisTypes.filter((type) => type.split('||').includes(token));
  if (bySegment.length > 0) return bySegment;
  return nerisTypes.filter((type) => (type.split('||').pop() ?? '').includes(token));
}

/** Plain names for the fields officers see; anything else is humanized from its key. */
const FIELD_LABELS: Record<string, string> = {
  incident_type: 'Incident type',
  action_taken: 'Actions taken',
  address: 'Incident address',
  location: 'Incident address',
  narrative: 'Narrative',
  outcome_narrative: 'Narrative',
  call_arrival: 'Time the call reached dispatch',
  call_answered: 'Time dispatch answered the call',
  call_create: 'Time the call was entered in CAD',
  incident_number: 'Incident number',
  department_neris_id: 'Department NERIS id',
  unit_neris_id: 'NERIS unit id',
  dispatch: 'Dispatch time',
  enroute_to_scene: 'En route time',
  on_scene: 'On scene time',
  unit_clear: 'Clear time',
  smoke_alarm: 'Smoke alarm section',
  fire_alarm: 'Fire alarm section',
  other_alarm: 'Other alarm section',
  fire_suppression: 'Sprinkler/suppression section',
  cooking_fire_suppression: 'Cooking suppression section',
  fire_detail: 'Fire details section',
  incident_types: 'Incident type',
  unit_responses: 'Responding units',
};

export function fieldLabel(key: string): string {
  const cleaned = key.replace(/\[\d+\]/g, '');
  const last = cleaned.split('.').filter(Boolean).pop() ?? cleaned;
  if (FIELD_LABELS[last]) return FIELD_LABELS[last];
  const words = last.replace(/_/g, ' ').trim();
  return words.length > 0 ? words[0]!.toUpperCase() + words.slice(1) : 'This field';
}

const TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'America/New_York',
});

function clock(epochSeconds: number): string {
  return TIME_FORMAT.format(new Date(epochSeconds * 1000));
}

const UNIT_STEPS = [
  { field: 'dispatchedAt', label: 'dispatched' },
  { field: 'enRouteAt', label: 'en route' },
  { field: 'arrivedAt', label: 'on scene' },
  { field: 'clearedAt', label: 'clear' },
] as const;

function incidentTypes(incident: Incident): unknown[] {
  const stored = incident.corePayload.incident_types;
  if (Array.isArray(stored) && stored.length > 0) return stored;
  const type = incident.corePayload.incident_type ?? incident.incidentType;
  return typeof type === 'string' && type.trim().length > 0 ? [{ type }] : [];
}

function typeValues(types: readonly unknown[]): string[] {
  return types.flatMap((entry) => {
    const type = (entry as { type?: unknown } | null)?.type;
    return typeof type === 'string' ? [type] : [];
  });
}

function hasModule(incident: Incident, key: string): boolean {
  const value = incident.corePayload[key];
  return value !== undefined && value !== null && value !== '';
}

function weAreAssisting(incident: Incident): boolean {
  const aids = incident.corePayload.aids;
  return (
    Array.isArray(aids) &&
    aids.some((aid) => (aid as { aid_direction?: unknown } | null)?.aid_direction === 'GIVEN')
  );
}

export function localValidation(input: LocalValidationInput): {
  blocking: ValidationIssue[];
  warnings: ValidationIssue[];
} {
  const { incident, settings, schema } = input;
  const blocking: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const core = incident.corePayload;

  if (!settings.departmentNerisId) {
    warnings.push({
      path: 'department_neris_id',
      code: 'DEPARTMENT_NOT_REGISTERED',
      section: 'neris',
      message:
        "The department's NERIS id isn't set, so nothing can reach NERIS yet. An admin can add it under Settings > NERIS.",
    });
  } else if (!settings.submissionsEnabled) {
    warnings.push({
      path: 'department_neris_id',
      code: 'SUBMISSIONS_DISABLED',
      section: 'neris',
      message: 'NERIS submissions are switched off for the department. Locking still works.',
    });
  }

  // Incident type: what the crew found, not what was dispatched.
  const types = incidentTypes(incident);
  const values = typeValues(types);
  if (values.length === 0 || values.every((value) => value === 'UNDETERMINED')) {
    blocking.push({
      path: 'fields.incident_type',
      code: 'INCIDENT_TYPE_REQUIRED',
      section: 'core',
      message: 'Pick the incident type — what the crew found on arrival, not what was dispatched.',
    });
  } else if (values.length > 3) {
    blocking.push({
      path: 'fields.incident_types',
      code: 'TOO_MANY_INCIDENT_TYPES',
      section: 'core',
      message: 'NERIS takes at most three incident types. Keep the primary one and up to two more.',
    });
  }
  // Every type must be a NERIS TypeIncidentValue (from the downloaded NERIS schema):
  // legacy local codes and raw CAD strings are refused before they can reach NERIS.
  if (input.nerisApi) {
    const nerisTypes = input.nerisApi.incidentTypes;
    for (const value of values) {
      if (value === 'UNDETERMINED' || nerisTypes.includes(value)) continue;
      const suggestions = suggestNerisTypes(value, nerisTypes);
      const only = suggestions.length === 1 ? suggestions[0] : undefined;
      blocking.push({
        path: 'fields.incident_type',
        code: 'INCIDENT_TYPE_NOT_NERIS',
        section: 'core',
        message:
          only !== undefined
            ? `"${value}" isn't a NERIS incident type. It matches ${incidentTypeLabel(only)}.`
            : suggestions.length > 1
              ? `"${value}" isn't a NERIS incident type. Pick one of the ${suggestions.length} NERIS types it could be (${incidentTypeLabel(suggestions[0]!.split('||').slice(0, 2).join('||'))} …).`
              : `"${value}" isn't a NERIS incident type. Pick the NERIS type from the list.`,
        ...(only !== undefined
          ? {
              fix: {
                label: `Use ${incidentTypeLabel(only)}`,
                path: 'fields.incident_type',
                value: only,
              },
            }
          : {}),
      });
    }
  } else if (values.length > 0) {
    warnings.push({
      path: 'fields.incident_type',
      code: 'NERIS_TYPES_UNAVAILABLE',
      section: 'core',
      message:
        "The NERIS incident-type list hasn't been downloaded yet, so the type can't be checked here. NERIS will check it.",
    });
  }

  // Cached NERIS schema pin: required fields and value lists.
  if (schema) {
    for (const field of schema.requiredFields) {
      const value = core[field];
      if (value === undefined || value === null || value === '') {
        if (field === 'incident_type' && values.length > 0) continue;
        if (blocking.some((issue) => issue.path === `fields.${field}`)) continue;
        blocking.push({
          path: `fields.${field}`,
          code: 'REQUIRED_FIELD',
          section: 'core',
          message: `${fieldLabel(field)} is required by NERIS.`,
        });
      }
    }
    for (const [field, allowed] of Object.entries(schema.enumerations)) {
      // The incident type is judged against the NERIS list above, not an older pin's list.
      if (field === 'incident_type' && input.nerisApi) continue;
      const value = core[field];
      if (typeof value === 'string' && value.length > 0 && !allowed.includes(value)) {
        blocking.push({
          path: `fields.${field}`,
          code: 'INVALID_VALUE',
          section: 'core',
          message: `"${value}" isn't a NERIS choice for ${fieldLabel(field).toLowerCase()}. Pick one from the list.`,
        });
      }
    }
  }

  // Location and call times (NERIS base.location, dispatch.call_* are required).
  const address = incident.address ?? core.address;
  if (
    (typeof address !== 'string' || address.trim().length === 0) &&
    !hasModule(incident, 'location')
  ) {
    blocking.push({
      path: 'fields.address',
      code: 'LOCATION_REQUIRED',
      section: 'dispatch',
      message: 'Add the incident address.',
    });
  }
  const alarmAt = incident.alarmAt ?? incident.epochSeconds;
  if (!Number.isFinite(alarmAt)) {
    blocking.push({
      path: 'fields.alarmAt',
      code: 'CALL_TIME_REQUIRED',
      section: 'dispatch',
      message: 'Add the time the call came in.',
    });
  }

  // Units: times in order, not before the call, department-required times present.
  const apparatus = input.units.filter((unit) => unit.unitType !== 'MEMBER');
  if (apparatus.length === 0) {
    warnings.push({
      path: 'units',
      code: 'NO_UNITS',
      section: 'units',
      message: 'No apparatus is listed as responding. Add the units that went, with their times.',
    });
  }
  for (const unit of apparatus) {
    const times = unit as unknown as Record<string, number | undefined>;
    const dispatched = unit.dispatchedAt;
    if (dispatched !== undefined && Number.isFinite(alarmAt) && dispatched < alarmAt) {
      blocking.push({
        path: `units.${unit.unitId}.dispatchedAt`,
        code: 'UNIT_DISPATCHED_BEFORE_CALL',
        section: 'units',
        message: `${unit.unitId} shows dispatched at ${clock(dispatched)}, before the call came in at ${clock(alarmAt)}.`,
        fix: {
          label: `Use the call time (${clock(alarmAt)}) as ${unit.unitId}'s dispatch time`,
          path: `units.${unit.unitId}.dispatchedAt`,
          value: alarmAt,
        },
      });
    }
    let previous: { label: string; value: number } | undefined;
    for (const step of UNIT_STEPS) {
      const value = times[step.field];
      if (value === undefined) continue;
      if (previous && value < previous.value) {
        blocking.push({
          path: `units.${unit.unitId}.${step.field}`,
          code: 'UNIT_TIMES_OUT_OF_ORDER',
          section: 'units',
          message: `Times out of order: ${unit.unitId} ${step.label} ${clock(value)} is before ${previous.label} ${clock(previous.value)}.`,
          fix: {
            label: `Use the ${previous.label} time (${clock(previous.value)}) for ${step.label}`,
            path: `units.${unit.unitId}.${step.field}`,
            value: previous.value,
          },
        });
      } else {
        previous = { label: step.label, value };
      }
    }
    if (settings.rules.requireUnitTimes) {
      const missing = UNIT_STEPS.filter(
        (step) => step.field !== 'enRouteAt' && times[step.field] === undefined,
      ).map((step) => step.label);
      if (missing.length > 0) {
        blocking.push({
          path: `units.${unit.unitId}`,
          code: 'UNIT_TIMES_MISSING',
          section: 'units',
          message: `${unit.unitId} is missing its ${missing.join(', ')} time${missing.length > 1 ? 's' : ''}.`,
        });
      }
    }
    if (settings.departmentNerisId && !settings.unitNerisIds[unit.unitId]) {
      warnings.push({
        path: `units.${unit.unitId}`,
        code: 'UNIT_NOT_REGISTERED',
        section: 'units',
        message: `${unit.unitId} isn't registered with NERIS yet, so it goes by name only. An admin can sync units under Settings > NERIS.`,
      });
    }
  }

  // Narrative (department rule; NERIS lists the outcome narrative as "highly desired").
  const narrative = (incident.narrative ?? (core.narrative as string | undefined) ?? '').trim();
  if (settings.rules.requireNarrative && narrative.length === 0) {
    blocking.push({
      path: 'narrative',
      code: 'NARRATIVE_REQUIRED',
      section: 'narrative',
      message: 'Write the narrative: what you found, what you did, and how it ended.',
    });
  } else if (narrative.length > 0 && narrative.length < settings.rules.minNarrativeLength) {
    blocking.push({
      path: 'narrative',
      code: 'NARRATIVE_TOO_SHORT',
      section: 'narrative',
      message: `The department asks for at least ${settings.rules.minNarrativeLength} characters of narrative (now ${narrative.length}).`,
    });
  } else if (narrative.length === 0) {
    warnings.push({
      path: 'narrative',
      code: 'NARRATIVE_EMPTY',
      section: 'narrative',
      message: 'NERIS strongly prefers an outcome narrative.',
    });
  }

  // Conditional fire modules (NERIS minimum data requirements).
  const isNerisTyped = values.some((value) => value.includes('||'));
  const fire = isNerisTyped
    ? hasIncidentCategory(types, 'FIRE')
    : values.some((value) => value.includes('FIRE'));
  if (!fire && isNerisTyped && hasModule(incident, 'fire_detail')) {
    blocking.push({
      path: 'fields.fire_detail',
      code: 'MODULE_NOT_ALLOWED',
      section: 'fire',
      message:
        'Fire details only go with a fire incident type. Change the type or clear the fire section.',
    });
  }
  const structureFire = values.some((value) => value.includes('STRUCTURE_FIRE'));
  if (structureFire) {
    const required = ['smoke_alarm', 'fire_alarm', 'other_alarm', 'fire_suppression'];
    if (values.some((value) => value.includes('COOKING'))) {
      required.push('cooking_fire_suppression');
    }
    const assisting = weAreAssisting(incident);
    for (const module of required) {
      if (hasModule(incident, module)) continue;
      (assisting ? warnings : blocking).push({
        path: `fields.${module}`,
        code: 'MODULE_REQUIRED',
        section: 'fire',
        message: `Structure fires need the ${fieldLabel(module).toLowerCase()}${assisting ? ' when you were the primary department' : ''}.`,
      });
    }
  }

  // Freshness: NERIS expects records within days, not months.
  const ageDays =
    (input.nowEpochSeconds - (Number.isFinite(alarmAt) ? alarmAt : incident.createdAt)) / 86_400;
  if (ageDays > 30 && incident.firstSubmittedAt === undefined) {
    warnings.push({
      path: 'fields.alarmAt',
      code: 'LATE_REPORT',
      section: 'core',
      message: `This call was ${Math.floor(ageDays)} days ago and hasn't reached NERIS yet.`,
    });
  }

  return { blocking, warnings };
}

/** A NERIS 422 issue in officer language. */
export function describeNerisIssue(issue: NerisIssue): ValidationIssue {
  const label = issue.path ? fieldLabel(issue.path) : 'The report';
  let message: string;
  switch (issue.code) {
    case 'missing':
      message = `${label} is missing, and NERIS requires it.`;
      break;
    case 'string_pattern_mismatch':
      message = `${label} isn't in the format NERIS expects.`;
      break;
    case 'enum':
    case 'literal_error':
      message = `${label} isn't a value NERIS accepts.`;
      break;
    case 'extra_forbidden':
      message = `${label} doesn't belong in this report for NERIS. Clear it.`;
      break;
    default:
      message = `${label}: ${issue.message}`;
  }
  return {
    path: issue.path,
    code: `NERIS_${issue.code.toUpperCase()}`,
    section: 'neris',
    message,
  };
}

export interface NerisValidationInput {
  /**
   * Built lazily inside the try: reading the NERIS config (SSM) or OAuth secret can fail —
   * the secret is set out-of-band — and that must be a warning, never a 503 on validate/lock.
   */
  readonly api: () => Promise<NerisApi>;
  readonly payload: NerisPayload;
  readonly departmentNerisId: string;
  readonly now: () => Date;
}

export async function nerisRoundTrip(input: NerisValidationInput): Promise<{
  blocking: ValidationIssue[];
  warnings: ValidationIssue[];
  nerisValidatedAt: string | null;
}> {
  try {
    const api = await input.api();
    const result = await api.validateIncident(input.departmentNerisId, input.payload);
    if (result.ok) {
      return { blocking: [], warnings: [], nerisValidatedAt: input.now().toISOString() };
    }
    if (result.kind === 'validation') {
      const issues =
        result.issues.length > 0
          ? result.issues
          : [{ path: '', code: 'error', message: 'NERIS rejected the report without details.' }];
      return { blocking: issues.map(describeNerisIssue), warnings: [], nerisValidatedAt: null };
    }
    return {
      blocking: [],
      warnings: [unreachable(`NERIS answered HTTP ${result.httpStatus}`)],
      nerisValidatedAt: null,
    };
  } catch {
    return {
      blocking: [],
      warnings: [unreachable('NERIS did not answer')],
      nerisValidatedAt: null,
    };
  }
}

function unreachable(detail: string): ValidationIssue {
  return {
    path: '',
    code: 'NERIS_UNREACHABLE',
    section: 'neris',
    message: `Couldn't check with NERIS just now (${detail}). The local checks still apply; try again before locking if you can.`,
  };
}

const ALL_SECTIONS: readonly ValidationSection[] = ['core', 'dispatch', 'units', 'narrative'];

export function summarize(
  blocking: readonly ValidationIssue[],
  warnings: readonly ValidationIssue[],
  nerisValidatedAt: string | null,
  options: { readonly fire: boolean; readonly nerisChecked: boolean },
): ValidationReport {
  const sections = [
    ...ALL_SECTIONS,
    ...(options.fire ? (['fire'] as const) : []),
    ...(options.nerisChecked ? (['neris'] as const) : []),
  ];
  const sectionsComplete = Object.fromEntries(
    sections.map((section) => [
      section,
      !blocking.some((issue) => issue.section === section) &&
        (section !== 'neris' || nerisValidatedAt !== null),
    ]),
  );
  return { blocking, warnings, nerisValidatedAt, sectionsComplete };
}

export interface RunValidationInput extends LocalValidationInput {
  readonly mode: ValidationMode;
  readonly api?: () => Promise<NerisApi>;
  readonly now?: () => Date;
}

/** Local, NERIS, or both — the NERIS half only when the department has a NERIS id. */
export async function runValidation(input: RunValidationInput): Promise<ValidationReport> {
  const local = input.mode === 'neris' ? { blocking: [], warnings: [] } : localValidation(input);
  const blocking: ValidationIssue[] = [...local.blocking];
  const warnings: ValidationIssue[] = [...local.warnings];
  let nerisValidatedAt: string | null = null;
  let nerisChecked = false;

  if (input.mode !== 'local') {
    const departmentNerisId = input.settings.departmentNerisId;
    if (departmentNerisId && input.api && !input.nerisApi) {
      warnings.push(unreachable("the NERIS schema hasn't been downloaded yet"));
    } else if (!departmentNerisId || !input.api || !input.nerisApi) {
      if (!warnings.some((issue) => issue.code === 'DEPARTMENT_NOT_REGISTERED')) {
        warnings.push(unreachable("the department's NERIS id isn't set"));
      }
    } else {
      nerisChecked = true;
      const payload = buildNerisIncidentPayload({
        incident: input.incident,
        units: input.units,
        departmentNerisId,
        unitNerisIds: input.settings.unitNerisIds,
        schema: input.nerisApi,
      });
      const neris = await nerisRoundTrip({
        api: input.api,
        payload,
        departmentNerisId,
        now: input.now ?? (() => new Date()),
      });
      blocking.push(...neris.blocking);
      warnings.push(...neris.warnings);
      nerisValidatedAt = neris.nerisValidatedAt;
    }
  }

  const values = typeValues(incidentTypes(input.incident));
  return summarize(blocking, warnings, nerisValidatedAt, {
    fire: values.some((value) => value.includes('FIRE')),
    nerisChecked,
  });
}
