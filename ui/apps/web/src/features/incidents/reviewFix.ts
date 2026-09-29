import type { AuthTokenSource } from '../../lib/apiClient';
import { putNarrative, putResponseTimes, updateIncident } from './api';
import type {
  IncidentDetail,
  TimeField,
  ValidationFix,
  ValidationIssue,
  ValidationSection,
} from './types';
import { TIME_FIELDS } from './types';

/** What an issue or fix `path` points at (incident-service nerisValidation path grammar). */
export type IssueTarget =
  | { kind: 'unitTime'; unitId: string; field: TimeField }
  | { kind: 'field'; name: string }
  | { kind: 'module'; name: string }
  | { kind: 'narrative' };

export function parseIssuePath(path: string): IssueTarget | undefined {
  if (path === 'narrative') return { kind: 'narrative' };
  if (path.startsWith('fields.') && path.length > 'fields.'.length) {
    return { kind: 'field', name: path.slice('fields.'.length) };
  }
  // `modules.<name>` (MODULE_REQUIRED / MODULE_INCOMPLETE): that module's editor.
  if (path.startsWith('modules.') && path.length > 'modules.'.length) {
    return { kind: 'module', name: path.slice('modules.'.length).split('.')[0] ?? '' };
  }
  if (path.startsWith('units.')) {
    const rest = path.slice('units.'.length);
    const dot = rest.lastIndexOf('.');
    if (dot <= 0) return undefined;
    const field = rest.slice(dot + 1);
    if (!(TIME_FIELDS as readonly string[]).includes(field)) return undefined;
    return { kind: 'unitTime', unitId: rest.slice(0, dot), field: field as TimeField };
  }
  return undefined;
}

/**
 * Applies a server-proposed fix through the existing edit routes and returns the patch to merge
 * into the cached incident. Throws the route's ApiError (e.g. 409 INCIDENT_LOCKED) unchanged.
 */
export async function applyValidationFix(
  tokens: AuthTokenSource,
  incident: IncidentDetail,
  fix: ValidationFix,
): Promise<Partial<IncidentDetail>> {
  const target = parseIssuePath(fix.path);
  if (!target || target.kind === 'module') {
    throw new Error(`This fix can't be applied here (${fix.path}).`);
  }
  if (target.kind === 'narrative') {
    return putNarrative(tokens, incident.incidentId, String(fix.value));
  }
  if (target.kind === 'field') {
    return updateIncident(tokens, incident.incidentId, {
      fields: { [target.name]: String(fix.value) },
    });
  }
  const value = Number(fix.value);
  if (!Number.isFinite(value))
    throw new Error(`The proposed time for ${target.unitId} is invalid.`);
  const unit = (incident.respondingUnits ?? []).find((item) => item.unitId === target.unitId);
  const saved = await putResponseTimes(tokens, incident.incidentId, {
    unitId: target.unitId,
    unitType: unit?.unitType ?? 'APPARATUS',
    [target.field]: value,
  });
  const units = incident.respondingUnits ?? [];
  return {
    respondingUnits: units.some((item) => item.unitId === saved.unitId)
      ? units.map((item) => (item.unitId === saved.unitId ? { ...item, ...saved } : item))
      : [...units, saved],
  };
}

/** Report step id for a validation section, when the path does not say more. */
const SECTION_STEP: Record<ValidationSection, string> = {
  core: 'type',
  dispatch: 'dispatch',
  units: 'units',
  narrative: 'narrative',
  fire: 'type',
  neris: 'review',
};

const FIELD_STEP: Record<string, string> = {
  cross_streets: 'location',
  incident_type: 'type',
  action_taken: 'type',
};

/** Where "Go to" should take the officer: the report step and, when it exists, the field id. */
export function focusTargetFor(issue: ValidationIssue): { stepId: string; fieldId?: string } {
  const target = parseIssuePath(issue.path);
  if (target?.kind === 'narrative') return { stepId: 'narrative', fieldId: 'field-narrative' };
  if (target?.kind === 'module') return { stepId: 'modules', fieldId: `module-${target.name}` };
  if (target?.kind === 'unitTime') {
    return {
      stepId: 'units',
      fieldId: `field-${target.unitId.replaceAll(' ', '-')}-${target.field}`,
    };
  }
  if (target?.kind === 'field') {
    return {
      stepId: FIELD_STEP[target.name] ?? SECTION_STEP[issue.section],
      fieldId: `field-${target.name}`,
    };
  }
  return { stepId: SECTION_STEP[issue.section] };
}
