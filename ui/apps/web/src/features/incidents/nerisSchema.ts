import type { NerisSchemaDocument, NerisSecondarySchemaDocument } from './validateEnum';

/**
 * Mirrors the incident service's published Core / Secondary fixtures
 * (`backend/src/services/incident-service/schemaVersion/fixtures.ts`).
 * The feature keeps this copy and `validateEnum.ts` applies the same rules the server does.
 * `incident_type` is a NERIS TypeIncidentValue: its list comes from GET incidents/neris-schema
 * (`useNerisSchema` / `withIncidentTypes`), never from here.
 */
export const CORE_SCHEMA: NerisSchemaDocument = {
  version: '2026.2',
  requiredFields: ['incident_type', 'action_taken'],
  enumerations: {
    action_taken: ['EXTINGUISH', 'INVESTIGATE', 'ASSIST_EMS', 'NO_ACTION'],
  },
};

export const SECONDARY_SCHEMA: NerisSecondarySchemaDocument = {
  version: '2026.2',
  requiredFieldsByType: { EXPOSURE: ['exposure_type'], RESPONDER_SAFETY: ['injury_type'] },
  enumerationsByType: {
    EXPOSURE: { exposure_type: ['SMOKE', 'CHEMICAL', 'BLOODBORNE'] },
    RESPONDER_SAFETY: { injury_type: ['BURN', 'STRAIN', 'LACERATION', 'NONE'] },
  },
};

export const SECONDARY_TYPES = ['EXPOSURE', 'RESPONDER_SAFETY'] as const;
export type SecondaryType = (typeof SECONDARY_TYPES)[number];

export const FIELD_LABELS: Record<string, string> = {
  incident_type: 'NERIS incident type',
  action_taken: 'Action taken',
  cross_streets: 'Cross streets',
  exposure_type: 'Exposure type',
  injury_type: 'Injury type',
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}
