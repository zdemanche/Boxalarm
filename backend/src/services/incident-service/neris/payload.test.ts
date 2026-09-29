import { describe, expect, it } from 'vitest';
import type { Incident } from '../entity.js';
import type { CompiledNerisSchema } from './apiSchema.js';
import compiled from './fixtures/neris-api-1.5.1.json' with { type: 'json' };
import {
  buildNerisIncidentPayload,
  canonicalJson,
  diffPayloads,
  locationFromAddress,
  payloadHash,
  toNerisIncidentNumber,
} from './payload.js';

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    incidentId: 'NICHOLS-4471-1798000000',
    deptId: 'NICHOLS',
    dispatchNumber: '26-4471',
    epochSeconds: 1_798_000_000,
    nerisSchemaVersion: '2026.2',
    corePayload: { incident_type: 'FIRE||STRUCTURE_FIRE||ROOM_AND_CONTENTS_FIRE' },
    address: '12 Main St, Trumbull, CT 06611',
    alarmAt: 1_798_000_000,
    narrative: 'Kitchen fire, extinguished by E1.',
    status: 'DRAFT',
    sourceDispatchId: 'NICHOLS-4471-1798000000',
    createdBy: 'MBR-0034',
    createdAt: 1_798_000_000,
    updatedAt: 1_798_000_000,
    ...overrides,
  };
}

const SCHEMA = compiled as unknown as CompiledNerisSchema;
const BASE_INPUT = {
  units: [],
  departmentNerisId: 'FD09190828',
  unitNerisIds: {},
  schema: SCHEMA,
};

describe('buildNerisIncidentPayload', () => {
  it('derives base, incident_types and dispatch from the incident', () => {
    const payload = buildNerisIncidentPayload({ ...BASE_INPUT, incident: incident() });

    expect(payload).toEqual({
      base: {
        department_neris_id: 'FD09190828',
        incident_number: '26-4471',
        outcome_narrative: 'Kitchen fire, extinguished by E1.',
        location: {
          number: 12,
          street: 'Main St',
          incorporated_municipality: 'Trumbull',
          state: 'CT',
          postal_code: '06611',
        },
      },
      incident_types: [{ type: 'FIRE||STRUCTURE_FIRE||ROOM_AND_CONTENTS_FIRE', primary: true }],
      dispatch: {
        incident_number: '26-4471',
        call_arrival: '2026-12-23T04:26:40.000Z',
        call_answered: '2026-12-23T04:26:40.000Z',
        call_create: '2026-12-23T04:26:40.000Z',
        location: {
          number: 12,
          street: 'Main St',
          incorporated_municipality: 'Trumbull',
          state: 'CT',
          postal_code: '06611',
        },
        unit_responses: [],
      },
    });
  });

  it('maps apparatus rows to unit responses with NERIS unit ids and staffing, skipping members', () => {
    const payload = buildNerisIncidentPayload({
      ...BASE_INPUT,
      unitNerisIds: { E1: 'FD09190828S001U001' },
      incident: incident(),
      units: [
        {
          unitId: 'E1',
          unitType: 'APPARATUS',
          dispatchedAt: 1_798_000_060,
          arrivedAt: 1_798_000_400,
          assignedPositions: ['OFFICER', 'DRIVER', 'FF1'],
        },
        { unitId: 'MBR-0034', unitType: 'MEMBER', dispatchedAt: 1_798_000_060 },
      ],
    });

    expect((payload.dispatch as { unit_responses: unknown[] }).unit_responses).toEqual([
      {
        reported_unit_id: 'E1',
        unit_neris_id: 'FD09190828S001U001',
        staffing: 3,
        dispatch: '2026-12-23T04:27:40.000Z',
        on_scene: '2026-12-23T04:33:20.000Z',
      },
    ]);
  });

  it('never emits keys outside the NERIS schema (additionalProperties: false)', () => {
    const payload = buildNerisIncidentPayload({
      ...BASE_INPUT,
      incident: incident({
        corePayload: {
          incident_type: 'FIRE||STRUCTURE_FIRE||ROOM_AND_CONTENTS_FIRE',
          action_taken: 'EXTINGUISH',
          cross_streets: 'Oak Ave',
          base: { people_present: true, internal_note: 'do not send' },
          dispatch: { determinant_code: '69D6', officer_scratch: 'x' },
          smoke_alarm: { presence: { type: 'PRESENT' } },
        },
      }),
    });

    expect(Object.keys(payload).sort()).toEqual([
      'base',
      'dispatch',
      'incident_types',
      'smoke_alarm',
    ]);
    expect(payload.base).toMatchObject({ people_present: true });
    expect(payload.base).not.toHaveProperty('internal_note');
    expect(payload.dispatch).toMatchObject({ determinant_code: '69D6' });
    expect(payload.dispatch).not.toHaveProperty('officer_scratch');
  });

  it('pins department id and incident number even if a stored base module disagrees', () => {
    const payload = buildNerisIncidentPayload({
      ...BASE_INPUT,
      incident: incident({
        corePayload: { base: { department_neris_id: 'FD00000000', incident_number: 'X' } },
      }),
    });

    expect(payload.base).toMatchObject({
      department_neris_id: 'FD09190828',
      incident_number: '26-4471',
    });
  });

  it('never sends patient identifiers: medical details only on MEDICAL incidents, PCR id stripped', () => {
    const medicalDetails = [
      {
        patient_care_evaluation: 'PATIENT_EVALUATED_CARE_PROVIDED',
        transport_disposition: 'TRANSPORT_BY_EMS_UNIT',
        patient_care_report_id: 'PCR-778812',
        patient_name: 'Jane Doe',
      },
    ];
    const fire = buildNerisIncidentPayload({
      ...BASE_INPUT,
      incident: incident({ corePayload: { medical_details: medicalDetails } }),
    });
    expect(fire).not.toHaveProperty('medical_details');

    const medical = buildNerisIncidentPayload({
      ...BASE_INPUT,
      incident: incident({
        corePayload: {
          incident_types: [{ type: 'MEDICAL||ILLNESS||BREATHING_PROBLEMS', primary: true }],
          medical_details: medicalDetails,
        },
      }),
    });
    expect(medical.medical_details).toEqual([
      {
        patient_care_evaluation: 'PATIENT_EVALUATED_CARE_PROVIDED',
        transport_disposition: 'TRANSPORT_BY_EMS_UNIT',
      },
    ]);
    expect(JSON.stringify(medical)).not.toMatch(/PCR-778812|Jane Doe/);
  });

  it('uses the CAD placeholder type when no incident type is known yet', () => {
    const payload = buildNerisIncidentPayload({
      ...BASE_INPUT,
      incident: incident({ corePayload: {} }),
    });
    expect(payload.incident_types).toEqual([{ type: 'UNDETERMINED' }]);
  });
});

describe('fire-only guardrail: nothing beyond the NERIS schema, no casualty demographics or names', () => {
  it('deep-picks every module: nested undeclared keys never leave Boxalarm', () => {
    const payload = buildNerisIncidentPayload({
      ...BASE_INPUT,
      incident: incident({
        corePayload: {
          incident_type: 'FIRE||STRUCTURE_FIRE||ROOM_AND_CONTENTS_FIRE',
          base: { location: { street: 'Main St', owner_name: 'Jane Doe' } },
          smoke_alarm: {
            presence: { type: 'PRESENT', working: true, homeowner_name: 'Jane Doe' },
            notes: 'called by Jane',
          },
          aids: [
            {
              department_neris_id: 'FD09190001',
              aid_type: 'SUPPORT_AID',
              aid_direction: 'GIVEN',
              officer_name: 'Capt. Smith',
            },
          ],
        },
      }),
    });

    expect(payload.smoke_alarm).toEqual({ presence: { type: 'PRESENT', working: true } });
    expect(payload.aids).toEqual([
      { department_neris_id: 'FD09190001', aid_type: 'SUPPORT_AID', aid_direction: 'GIVEN' },
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/Jane|Smith|called by/);
  });

  it('sends only the required casualty fields: no birth month/year, gender, race or names', () => {
    const payload = buildNerisIncidentPayload({
      ...BASE_INPUT,
      incident: incident({
        corePayload: {
          incident_type: 'FIRE||STRUCTURE_FIRE||ROOM_AND_CONTENTS_FIRE',
          casualty_rescues: [
            {
              type: 'NONFF',
              birth_month_year: '04/1961',
              gender: 'FEMALE',
              race: 'WHITE',
              name: 'Jane Doe',
              casualty: { injury_or_noninjury: { type: 'INJURED_NONFATAL', cause: 'EXPOSURE' } },
            },
          ],
        },
      }),
    });
    expect(payload.casualty_rescues).toEqual([{ type: 'NONFF' }]);
    expect(JSON.stringify(payload)).not.toMatch(/1961|FEMALE|WHITE|Jane/);
  });
});

describe('payload helpers', () => {
  it('normalizes incident numbers to the NERIS pattern', () => {
    expect(toNerisIncidentNumber('26-4471')).toBe('26-4471');
    expect(toNerisIncidentNumber('26/4471 A')).toBe('26-4471-A');
  });

  it('keeps an unparseable address as the street', () => {
    expect(locationFromAddress('Rte 25 near exit 9')).toEqual({ street: 'Rte 25 near exit 9' });
    expect(locationFromAddress(undefined)).toEqual({});
  });

  it('hashes key-order independently', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  });

  it('diffs leaf changes, additions and removals', () => {
    expect(
      diffPayloads(
        { base: { outcome_narrative: 'a', people_present: true }, list: [1] },
        { base: { outcome_narrative: 'b' }, list: [1, 2] },
      ),
    ).toEqual([
      { path: 'base.outcome_narrative', before: 'a', after: 'b' },
      { path: 'base.people_present', before: true },
      { path: 'list[1]', after: 2 },
    ]);
  });
});
