import type { NerisSchemaDocument, NerisSecondarySchemaDocument } from './entity.js';

export const CORE_SCHEMA_V_N: NerisSchemaDocument = {
  version: '2026.2',
  requiredFields: ['incident_type', 'action_taken'],
  enumerations: {
    incident_type: ['STRUCTURE_FIRE', 'VEHICLE_FIRE', 'EMS_ASSIST', 'FALSE_ALARM'],
    action_taken: ['EXTINGUISH', 'INVESTIGATE', 'ASSIST_EMS', 'NO_ACTION'],
  },
};

export const CORE_SCHEMA_V_N_MINUS_1: NerisSchemaDocument = {
  version: '2026.1',
  requiredFields: ['incident_type', 'action_taken'],
  enumerations: {
    incident_type: ['STRUCTURE_FIRE', 'VEHICLE_FIRE', 'EMS_ASSIST'],
    action_taken: ['EXTINGUISH', 'INVESTIGATE', 'ASSIST_EMS'],
  },
};

export const SECONDARY_SCHEMA_V_N: NerisSecondarySchemaDocument = {
  version: '2026.2',
  requiredFieldsByType: { EXPOSURE: ['exposure_type'], RESPONDER_SAFETY: ['injury_type'] },
  enumerationsByType: {
    EXPOSURE: { exposure_type: ['SMOKE', 'CHEMICAL', 'BLOODBORNE'] },
    RESPONDER_SAFETY: { injury_type: ['BURN', 'STRAIN', 'LACERATION', 'NONE'] },
  },
};

export const SECONDARY_SCHEMA_V_N_MINUS_1: NerisSecondarySchemaDocument = {
  version: '2026.1',
  requiredFieldsByType: { EXPOSURE: ['exposure_type'] },
  enumerationsByType: {
    EXPOSURE: { exposure_type: ['SMOKE', 'CHEMICAL'] },
  },
};
