import { describe, expect, it } from 'vitest';
import {
  missingRequiredCoreFields,
  missingRequiredSecondaryFields,
  validateCoreFields,
  validateSecondaryFields,
} from './validateEnum.js';
import {
  CORE_SCHEMA_V_N,
  CORE_SCHEMA_V_N_MINUS_1,
  SECONDARY_SCHEMA_V_N,
  SECONDARY_SCHEMA_V_N_MINUS_1,
} from './fixtures.js';

describe.each([
  ['N', CORE_SCHEMA_V_N],
  ['N-1', CORE_SCHEMA_V_N_MINUS_1],
])('validateCoreFields against schema %s (F7.10 contract matrix)', (_label, schema) => {
  it('accepts a value in the enumeration', () => {
    expect(validateCoreFields(schema, { incident_type: 'STRUCTURE_FIRE' })).toEqual([]);
  });

  it('rejects a value outside the enumeration', () => {
    const errors = validateCoreFields(schema, { incident_type: 'NOT_A_REAL_TYPE' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe('incident_type');
    expect(errors[0]?.message).toMatch(/must be one of/);
  });

  it('flags a missing required field', () => {
    expect(missingRequiredCoreFields(schema, { incident_type: 'STRUCTURE_FIRE' })).toEqual([
      'action_taken',
    ]);
  });

  it('reports no missing fields once all required fields are present', () => {
    expect(
      missingRequiredCoreFields(schema, {
        incident_type: 'STRUCTURE_FIRE',
        action_taken: 'EXTINGUISH',
      }),
    ).toEqual([]);
  });
});

describe.each([
  ['N', SECONDARY_SCHEMA_V_N],
  ['N-1', SECONDARY_SCHEMA_V_N_MINUS_1],
])('validateSecondaryFields against schema %s (F7.10 contract matrix)', (_label, schema) => {
  it('accepts a value in the Secondary enumeration for the module type', () => {
    expect(validateSecondaryFields(schema, 'EXPOSURE', { exposure_type: 'SMOKE' })).toEqual([]);
  });

  it('rejects a value outside the Secondary enumeration', () => {
    const errors = validateSecondaryFields(schema, 'EXPOSURE', { exposure_type: 'RADIATION' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe('exposure_type');
    expect(errors[0]?.message).toMatch(/must be one of/);
  });

  it('flags a missing required Secondary field for the module type', () => {
    expect(missingRequiredSecondaryFields(schema, 'EXPOSURE', {})).toEqual(['exposure_type']);
  });
});
