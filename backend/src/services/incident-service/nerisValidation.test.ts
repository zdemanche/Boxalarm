import { describe, expect, it, vi } from 'vitest';
import type { Incident } from './entity.js';
import { DEFAULT_NERIS_SETTINGS, type NerisDeptSettings } from './nerisSettings.js';
import type { NerisApi } from './neris/api.js';
import type { CompiledNerisSchema } from './neris/apiSchema.js';
import compiled from './neris/fixtures/neris-api-1.5.1.json' with { type: 'json' };
import {
  suggestNerisTypes,
  describeNerisIssue,
  fieldLabel,
  localValidation,
  runValidation,
  type ValidationIssue,
} from './nerisValidation.js';

const ALARM = 1_798_000_000;
const NOW = ALARM + 3_600;

function incident(overrides: Record<string, unknown> = {}): Incident {
  return {
    incidentId: 'NICHOLS-4471-1798000000',
    deptId: 'NICHOLS',
    dispatchNumber: '4471',
    epochSeconds: ALARM,
    nerisSchemaVersion: '2026.2',
    corePayload: { incident_type: 'FIRE||OUTSIDE_FIRE||DUMPSTER_OUTDOOR_CONTAINER_FIRE' },
    address: '12 Main St, Trumbull, CT 06611',
    alarmAt: ALARM,
    narrative: 'Dumpster fire behind the plaza, knocked down with the booster line.',
    status: 'DRAFT',
    sourceDispatchId: 'NICHOLS-4471-1798000000',
    createdBy: 'MBR-0034',
    createdAt: ALARM,
    updatedAt: ALARM,
    ...overrides,
  };
}

const NERIS_API = compiled as unknown as CompiledNerisSchema;

const SETTINGS: NerisDeptSettings = {
  ...DEFAULT_NERIS_SETTINGS,
  departmentNerisId: 'FD09190828',
  unitNerisIds: { E1: 'FD09190828S001U001' },
};

const E1 = {
  unitId: 'E1',
  unitType: 'APPARATUS',
  dispatchedAt: ALARM + 60,
  enRouteAt: ALARM + 120,
  arrivedAt: ALARM + 400,
  clearedAt: ALARM + 1_800,
};

function codes(issues: readonly ValidationIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

describe('localValidation', () => {
  it('passes a complete outside-fire report with nothing blocking', () => {
    const result = localValidation({
      incident: incident(),
      units: [E1],
      settings: SETTINGS,
      nerisApi: NERIS_API,
      nowEpochSeconds: NOW,
    });
    expect(result.blocking).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('blocks a report with no incident type, address or narrative, in plain language', () => {
    const result = localValidation({
      incident: incident({ corePayload: {}, address: undefined, narrative: undefined }),
      units: [E1],
      settings: SETTINGS,
      nerisApi: NERIS_API,
      nowEpochSeconds: NOW,
    });
    expect(codes(result.blocking)).toEqual([
      'INCIDENT_TYPE_REQUIRED',
      'LOCATION_REQUIRED',
      'NARRATIVE_REQUIRED',
    ]);
    expect(result.blocking[0]!.message).toMatch(/what the crew found/);
  });

  it('flags unit times out of order with a one-tap fix to the earlier time', () => {
    const result = localValidation({
      incident: incident(),
      units: [{ ...E1, enRouteAt: ALARM + 30 }],
      settings: SETTINGS,
      nerisApi: NERIS_API,
      nowEpochSeconds: NOW,
    });
    const issue = result.blocking.find((i) => i.code === 'UNIT_TIMES_OUT_OF_ORDER')!;
    expect(issue.path).toBe('units.E1.enRouteAt');
    expect(issue.message).toMatch(/E1 en route .* is before dispatched/);
    expect(issue.fix).toEqual({
      label: expect.stringContaining('Use the dispatched time') as unknown,
      path: 'units.E1.enRouteAt',
      value: ALARM + 60,
    });
  });

  it('offers the call time as the fix for a unit dispatched before the call came in', () => {
    const result = localValidation({
      incident: incident(),
      units: [{ ...E1, dispatchedAt: ALARM - 90 }],
      settings: SETTINGS,
      nerisApi: NERIS_API,
      nowEpochSeconds: NOW,
    });
    const issue = result.blocking.find((i) => i.code === 'UNIT_DISPATCHED_BEFORE_CALL')!;
    expect(issue.fix).toMatchObject({ path: 'units.E1.dispatchedAt', value: ALARM });
  });

  it('applies department rules: missing unit times and short narratives', () => {
    const result = localValidation({
      incident: incident({ narrative: 'Out.' }),
      units: [{ unitId: 'E1', unitType: 'APPARATUS', dispatchedAt: ALARM + 60 }],
      settings: { ...SETTINGS, rules: { ...SETTINGS.rules, minNarrativeLength: 20 } },
      nerisApi: NERIS_API,
      nowEpochSeconds: NOW,
    });
    expect(codes(result.blocking)).toEqual(['UNIT_TIMES_MISSING', 'NARRATIVE_TOO_SHORT']);
    expect(result.blocking[0]!.message).toBe('E1 is missing its on scene, clear times.');
  });

  it('lets a department turn the unit-time and narrative rules off', () => {
    const result = localValidation({
      incident: incident({ narrative: undefined }),
      units: [{ unitId: 'E1', unitType: 'APPARATUS', dispatchedAt: ALARM + 60 }],
      settings: {
        ...SETTINGS,
        rules: { requireNarrative: false, minNarrativeLength: 0, requireUnitTimes: false },
      },
      nerisApi: NERIS_API,
      nowEpochSeconds: NOW,
    });
    expect(result.blocking).toEqual([]);
    expect(codes(result.warnings)).toEqual(['NARRATIVE_EMPTY']);
  });

  it('requires the alarm and suppression modules on a structure fire, cooking suppression on a cooking fire', () => {
    const result = localValidation({
      incident: incident({
        corePayload: {
          incident_type: 'FIRE||STRUCTURE_FIRE||CONFINED_COOKING_APPLIANCE_FIRE',
          smoke_alarm: { presence: { type: 'PRESENT' } },
        },
      }),
      units: [E1],
      settings: SETTINGS,
      nerisApi: NERIS_API,
      nowEpochSeconds: NOW,
    });
    expect(result.blocking.filter((i) => i.code === 'MODULE_REQUIRED').map((i) => i.path)).toEqual([
      'modules.fire_alarm',
      'modules.other_alarm',
      'modules.fire_suppression',
      'modules.cooking_fire_suppression',
    ]);
  });

  it('only warns about structure-fire modules when the department gave aid rather than led', () => {
    const result = localValidation({
      incident: incident({
        corePayload: {
          incident_type: 'FIRE||STRUCTURE_FIRE||ROOM_AND_CONTENTS_FIRE',
          aids: [
            { department_neris_id: 'FD09190001', aid_type: 'SUPPORT_AID', aid_direction: 'GIVEN' },
          ],
        },
      }),
      units: [E1],
      settings: SETTINGS,
      nerisApi: NERIS_API,
      nowEpochSeconds: NOW,
    });
    expect(result.blocking).toEqual([]);
    expect(codes(result.warnings)).toContain('MODULE_REQUIRED');
  });

  it('rejects fire details on a non-fire incident type', () => {
    const result = localValidation({
      incident: incident({
        corePayload: {
          incident_type: 'PUBSERV||ALARMS_NONMED||FIRE_ALARM',
          fire_detail: { location_detail: {} },
        },
      }),
      units: [E1],
      settings: SETTINGS,
      nerisApi: NERIS_API,
      nowEpochSeconds: NOW,
    });
    expect(codes(result.blocking)).toEqual(['MODULE_NOT_ALLOWED']);
  });

  it('checks the cached schema pin: required fields and NERIS value lists', () => {
    const result = localValidation({
      incident: incident({ corePayload: { incident_type: 'STRUCTURE_FIRE_X' } }),
      units: [E1],
      settings: SETTINGS,
      schema: {
        version: '2026.2',
        requiredFields: ['incident_type', 'action_taken'],
        enumerations: { incident_type: ['STRUCTURE_FIRE', 'VEHICLE_FIRE'] },
      },
      nerisApi: NERIS_API,
      nowEpochSeconds: NOW,
    });
    expect(result.blocking.map((i) => [i.code, i.path])).toEqual(
      expect.arrayContaining([
        ['REQUIRED_FIELD', 'fields.action_taken'],
        // The incident type is judged against the NERIS list, not the pin's local list.
        ['INCIDENT_TYPE_NOT_NERIS', 'fields.incident_type'],
      ]),
    );
  });

  it('warns (never blocks) when the department is not registered with NERIS, or a unit is not', () => {
    const unregistered = localValidation({
      incident: incident(),
      units: [E1],
      settings: DEFAULT_NERIS_SETTINGS,
      nerisApi: NERIS_API,
      nowEpochSeconds: NOW,
    });
    expect(unregistered.blocking).toEqual([]);
    expect(codes(unregistered.warnings)).toEqual(['DEPARTMENT_NOT_REGISTERED']);

    const newUnit = localValidation({
      incident: incident(),
      units: [{ ...E1, unitId: 'T2' }],
      settings: SETTINGS,
      nerisApi: NERIS_API,
      nowEpochSeconds: NOW,
    });
    expect(codes(newUnit.warnings)).toEqual(['UNIT_NOT_REGISTERED']);
  });

  it('warns on a report more than 30 days old that never reached NERIS', () => {
    const result = localValidation({
      incident: incident(),
      units: [E1],
      settings: SETTINGS,
      nerisApi: NERIS_API,
      nowEpochSeconds: ALARM + 40 * 86_400,
    });
    expect(codes(result.warnings)).toEqual(['LATE_REPORT']);
  });
});

function fakeApi(validate: NerisApi['validateIncident']): () => Promise<NerisApi> {
  return () => Promise.resolve({ validateIncident: validate } as unknown as NerisApi);
}

describe('NERIS incident types (TypeIncidentValue from the downloaded NERIS schema)', () => {
  const nerisApi = NERIS_API;

  it('accepts a NERIS type and blocks a legacy local code with the NERIS types it could be', () => {
    const ok = localValidation({
      incident: incident(),
      units: [E1],
      settings: SETTINGS,
      nerisApi,
      nowEpochSeconds: NOW,
    });
    expect(ok.blocking).toEqual([]);

    const legacy = localValidation({
      incident: incident({ corePayload: { incident_type: 'STRUCTURE_FIRE' } }),
      units: [E1],
      settings: SETTINGS,
      nerisApi,
      nowEpochSeconds: NOW,
    });
    const issue = legacy.blocking.find((i) => i.code === 'INCIDENT_TYPE_NOT_NERIS')!;
    expect(issue.message).toMatch(/Pick one of the 4 NERIS types/);
    expect(issue.fix).toBeUndefined();
  });

  it('offers a one-tap fix when a CAD string maps to exactly one NERIS type', () => {
    const result = localValidation({
      incident: incident({ corePayload: { incident_type: 'Chimney fire' } }),
      units: [E1],
      settings: SETTINGS,
      nerisApi,
      nowEpochSeconds: NOW,
    });
    expect(result.blocking.find((i) => i.code === 'INCIDENT_TYPE_NOT_NERIS')?.fix).toEqual({
      label: 'Use Fire › Structure fire › Chimney fire',
      path: 'fields.incident_type',
      value: 'FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE',
    });
  });

  it('warns rather than guessing when the NERIS schema has not been downloaded', () => {
    const result = localValidation({
      incident: incident({ corePayload: { incident_type: 'STRUCTURE_FIRE' } }),
      units: [E1],
      settings: SETTINGS,
      nowEpochSeconds: NOW,
    });
    expect(result.warnings.map((w) => w.code)).toContain('NERIS_TYPES_UNAVAILABLE');
  });

  it('suggests by segment first, then by leaf', () => {
    expect(suggestNerisTypes('FALSE_ALARM', nerisApi.incidentTypes)).toHaveLength(5);
    expect(suggestNerisTypes('odor', nerisApi.incidentTypes)).toEqual([
      'HAZSIT||INVESTIGATION||ODOR',
    ]);
    expect(suggestNerisTypes('', nerisApi.incidentTypes)).toEqual([]);
  });
});

describe('UNDETERMINED', () => {
  it('blocks UNDETERMINED alongside real incident types', () => {
    const result = localValidation({
      incident: incident({
        corePayload: {
          incident_types: [
            { type: 'FIRE||OUTSIDE_FIRE||DUMPSTER_OUTDOOR_CONTAINER_FIRE' },
            { type: 'UNDETERMINED' },
          ],
        },
      }),
      units: [E1],
      settings: SETTINGS,
      nerisApi: NERIS_API,
      nowEpochSeconds: NOW,
    });
    expect(codes(result.blocking)).toContain('UNDETERMINED_WITH_TYPES');
  });
});

describe('casualties and rescues', () => {
  function withCasualties(casualty_rescues: unknown, nerisApi?: CompiledNerisSchema) {
    return localValidation({
      incident: incident({
        corePayload: {
          incident_type: 'FIRE||OUTSIDE_FIRE||DUMPSTER_OUTDOOR_CONTAINER_FIRE',
          casualty_rescues,
        },
      }),
      units: [E1],
      settings: SETTINGS,
      ...(nerisApi ? { nerisApi } : {}),
      nowEpochSeconds: NOW,
    });
  }

  it('blocks a casualty with no FF/NONFF type, with or without the NERIS schema', () => {
    for (const api of [NERIS_API, undefined]) {
      const result = withCasualties(
        [{ type: 'FF' }, { casualty: { injury_or_noninjury: { type: 'UNINJURED' } } }],
        api,
      );
      const issue = result.blocking.find((i) => i.code === 'CASUALTY_INCOMPLETE');
      expect(issue?.message).toMatch(/has no type/);
    }
  });

  it('blocks a bad outcome code but not a bad demographic that is never sent', () => {
    const bad = withCasualties(
      [{ type: 'NONFF', casualty: { injury_or_noninjury: { type: 'INJURED_SOMEWHAT' } } }],
      NERIS_API,
    );
    expect(codes(bad.blocking)).toContain('CASUALTY_INCOMPLETE');

    const ok = withCasualties(
      [
        {
          type: 'NONFF',
          gender: 'NOT_A_GENDER',
          casualty: { injury_or_noninjury: { type: 'INJURED_FATAL', cause: 'COLLAPSE' } },
        },
      ],
      NERIS_API,
    );
    expect(codes(ok.blocking)).not.toContain('CASUALTY_INCOMPLETE');
  });
});

describe('runValidation', () => {
  const base = {
    incident: incident(),
    units: [E1],
    settings: SETTINGS,
    nerisApi: NERIS_API,
    nowEpochSeconds: NOW,
    now: () => new Date('2026-09-29T12:00:00.000Z'),
  };

  it('local mode never calls NERIS', async () => {
    const validate = vi.fn();
    const report = await runValidation({ ...base, mode: 'local', api: fakeApi(validate) });
    expect(validate).not.toHaveBeenCalled();
    expect(report).toEqual({
      blocking: [],
      warnings: [],
      nerisValidatedAt: null,
      sectionsComplete: { core: true, dispatch: true, units: true, narrative: true, fire: true },
    });
  });

  it('both: sends the built NERIS payload to /validate and stamps nerisValidatedAt on 204', async () => {
    const validate = vi.fn().mockResolvedValue({ ok: true, httpStatus: 204 });
    const report = await runValidation({ ...base, mode: 'both', api: fakeApi(validate) });
    expect(validate).toHaveBeenCalledWith(
      'FD09190828',
      expect.objectContaining({
        base: expect.objectContaining({ department_neris_id: 'FD09190828' }) as unknown,
      }),
    );
    expect(report.nerisValidatedAt).toBe('2026-09-29T12:00:00.000Z');
    expect(report.sectionsComplete.neris).toBe(true);
  });

  it('turns NERIS 422 issues into blocking items in fire-service language', async () => {
    const validate = vi.fn().mockResolvedValue({
      ok: false,
      kind: 'validation',
      httpStatus: 422,
      issues: [{ path: 'dispatch.call_create', code: 'missing', message: 'Field required' }],
    });
    const report = await runValidation({ ...base, mode: 'neris', api: fakeApi(validate) });
    expect(report.blocking).toEqual([
      {
        path: 'dispatch.call_create',
        code: 'NERIS_MISSING',
        section: 'neris',
        message: 'Time the call was entered in CAD is missing, and NERIS requires it.',
      },
    ]);
    expect(report.sectionsComplete.neris).toBe(false);
  });

  it('a NERIS outage is a warning, never a block', async () => {
    const report = await runValidation({
      ...base,
      mode: 'both',
      api: fakeApi(vi.fn().mockRejectedValue(new Error('ETIMEDOUT'))),
    });
    expect(report.blocking).toEqual([]);
    expect(codes(report.warnings)).toEqual(['NERIS_UNREACHABLE']);
  });
});

describe('labels', () => {
  it('names NERIS paths in officer terms', () => {
    expect(fieldLabel('dispatch.unit_responses[0].on_scene')).toBe('On scene time');
    expect(fieldLabel('base.people_present')).toBe('People present');
    expect(
      describeNerisIssue({
        path: 'base.incident_number',
        code: 'string_pattern_mismatch',
        message: '',
      }).message,
    ).toBe("Incident number isn't in the format NERIS expects.");
  });
});
