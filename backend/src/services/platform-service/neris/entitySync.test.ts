import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { NerisApi } from '../../incident-service/neris/api.js';
import {
  parseSyncRequest,
  saveEntityRecord,
  syncEntity,
  type EntitySyncRecord,
} from './entitySync.js';

const ENTITY = 'FD09190828';
const NOW = new Date('2026-09-29T12:00:00.000Z');

const REQUEST = {
  stations: [
    {
      stationId: 'STA1',
      addressLine1: '1 Firehouse Ln',
      city: 'Trumbull',
      state: 'CT',
      zipCode: '06611',
      units: [
        { unitId: 'E1', type: 'ENGINE_STRUCT', staffing: 4 },
        { unitId: 'T2', type: 'LADDER_TALL', staffing: 3 },
      ],
    },
  ],
};

function fakeApi(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const fns: Record<string, ReturnType<typeof vi.fn>> = {
    createStation: vi
      .fn()
      .mockResolvedValue({ ok: true, httpStatus: 201, nerisId: `${ENTITY}S001` }),
    patchStation: vi.fn().mockResolvedValue({ ok: true, httpStatus: 200 }),
    createUnit: vi
      .fn()
      .mockResolvedValueOnce({ ok: true, httpStatus: 201, nerisId: `${ENTITY}S001U001` })
      .mockResolvedValueOnce({
        ok: false,
        kind: 'validation',
        httpStatus: 422,
        issues: [{ path: 'type', code: 'enum', message: 'Input should be ...' }],
      }),
    patchUnit: vi.fn().mockResolvedValue({ ok: true, httpStatus: 200 }),
    getEntity: vi.fn().mockResolvedValue({ ok: true, httpStatus: 200, stations: [] }),
    ...overrides,
  };
  return { api: fns as unknown as NerisApi, fns };
}

describe('parseSyncRequest', () => {
  it('accepts a station with units', () => {
    expect(parseSyncRequest(REQUEST)).toEqual(REQUEST);
  });

  it('names every bad field', () => {
    const errors = parseSyncRequest({
      stations: [
        {
          stationId: 'STA1',
          addressLine1: '1 Firehouse Ln',
          city: 'Trumbull',
          state: 'Connecticut',
          zipCode: '6611',
          units: [
            { unitId: 'E1', type: 'PUMPER', staffing: 4 },
            { unitId: 'E1', type: 'ENGINE_STRUCT', staffing: -1 },
          ],
        },
      ],
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        { field: 'stations[0].state', message: 'must be the two-letter state code' },
        { field: 'stations[0].zipCode', message: 'must be a 5-digit ZIP code' },
        {
          field: 'stations[0].units[0].type',
          message: 'must be a NERIS unit type, e.g. ENGINE_STRUCT',
        },
        { field: 'stations[0].units[1].unitId', message: 'is listed twice' },
        { field: 'stations[0].units[1].staffing', message: 'must be a whole number of seats' },
      ]),
    );
    expect(parseSyncRequest({})).toEqual([
      { field: 'stations', message: 'is required and must be a non-empty array' },
    ]);
  });
});

describe('syncEntity', () => {
  it('creates the station, then its units, recording each NERIS id and each failure', async () => {
    const { api, fns } = fakeApi();
    const record = await syncEntity(api, ENTITY, REQUEST, undefined, 'MBR-0001', NOW);

    expect(fns.createStation).toHaveBeenCalledWith(ENTITY, {
      station_id: 'STA1',
      address_line_1: '1 Firehouse Ln',
      city: 'Trumbull',
      state: 'CT',
      zip_code: '06611',
    });
    expect(fns.createUnit).toHaveBeenCalledWith(ENTITY, `${ENTITY}S001`, {
      type: 'ENGINE_STRUCT',
      staffing: 4,
      cad_designation_1: 'E1',
    });
    expect(record).toEqual({
      departmentNerisId: ENTITY,
      stations: [{ stationId: 'STA1', nerisId: `${ENTITY}S001`, status: 'CREATED' }],
      units: [
        { unitId: 'E1', stationId: 'STA1', nerisId: `${ENTITY}S001U001`, status: 'CREATED' },
        { unitId: 'T2', stationId: 'STA1', status: 'FAILED' },
      ],
      errors: [
        { subject: 'unit T2', message: 'NERIS refused it (HTTP 422): type: Input should be ...' },
      ],
      syncedAt: NOW.toISOString(),
      syncedBy: 'MBR-0001',
    });
  });

  it('patches what NERIS already has instead of creating duplicates', async () => {
    const previous: EntitySyncRecord = {
      departmentNerisId: ENTITY,
      stations: [{ stationId: 'STA1', nerisId: `${ENTITY}S001`, status: 'CREATED' }],
      units: [{ unitId: 'E1', stationId: 'STA1', nerisId: `${ENTITY}S001U001`, status: 'CREATED' }],
      errors: [],
      syncedAt: '2026-09-01T00:00:00.000Z',
      syncedBy: 'MBR-0001',
    };
    const { api, fns } = fakeApi({
      createUnit: vi
        .fn()
        .mockResolvedValue({ ok: true, httpStatus: 201, nerisId: `${ENTITY}S001U002` }),
    });
    const record = await syncEntity(api, ENTITY, REQUEST, previous, 'MBR-0001', NOW);

    expect(fns.createStation).not.toHaveBeenCalled();
    expect(fns.patchStation).toHaveBeenCalledWith(ENTITY, `${ENTITY}S001`, expect.anything());
    expect(fns.patchUnit).toHaveBeenCalledWith(
      ENTITY,
      `${ENTITY}S001`,
      `${ENTITY}S001U001`,
      expect.anything(),
    );
    expect(record.units.map((u) => u.status)).toEqual(['UPDATED', 'CREATED']);
  });

  it('keeps the NERIS ids of units left out of the request instead of losing them (review minor 8)', async () => {
    const previous: EntitySyncRecord = {
      departmentNerisId: ENTITY,
      stations: [{ stationId: 'STA1', nerisId: `${ENTITY}S001`, status: 'CREATED' }],
      units: [
        { unitId: 'E1', stationId: 'STA1', nerisId: `${ENTITY}S001U001`, status: 'CREATED' },
        { unitId: 'R9', stationId: 'STA1', nerisId: `${ENTITY}S001U009`, status: 'CREATED' },
      ],
      errors: [],
      syncedAt: '2026-09-01T00:00:00.000Z',
      syncedBy: 'MBR-0001',
    };
    const { api } = fakeApi({
      createUnit: vi
        .fn()
        .mockResolvedValue({ ok: true, httpStatus: 201, nerisId: `${ENTITY}S001U002` }),
    });
    const record = await syncEntity(api, ENTITY, REQUEST, previous, 'MBR-0001', NOW);
    expect(record.units).toContainEqual({
      unitId: 'R9',
      stationId: 'STA1',
      nerisId: `${ENTITY}S001U009`,
      status: 'RETAINED',
    });
  });

  it('does not reuse station or unit ids after the department NERIS id changed', async () => {
    const previous: EntitySyncRecord = {
      departmentNerisId: 'FD00000001',
      stations: [{ stationId: 'STA1', nerisId: 'FD00000001S001', status: 'CREATED' }],
      units: [
        { unitId: 'E1', stationId: 'STA1', nerisId: 'FD00000001S001U001', status: 'CREATED' },
      ],
      errors: [],
      syncedAt: '2026-09-01T00:00:00.000Z',
      syncedBy: 'MBR-0001',
    };
    const { api, fns } = fakeApi();
    const record = await syncEntity(api, ENTITY, REQUEST, previous, 'MBR-0001', NOW);
    expect(fns.createStation).toHaveBeenCalled();
    expect(fns.patchStation).not.toHaveBeenCalled();
    expect(record.units.some((u) => u.nerisId?.startsWith('FD00000001'))).toBe(false);
  });

  it("skips a station's units when the station itself could not be registered", async () => {
    const { api } = fakeApi({
      createStation: vi
        .fn()
        .mockResolvedValue({ ok: false, kind: 'client_error', httpStatus: 403, issues: [] }),
    });
    const record = await syncEntity(api, ENTITY, REQUEST, undefined, 'MBR-0001', NOW);
    expect(record.units.map((u) => u.status)).toEqual(['SKIPPED', 'SKIPPED']);
    expect(record.errors).toEqual([
      { subject: 'station STA1', message: 'NERIS answered HTTP 403' },
    ]);
  });
});

describe('saveEntityRecord', () => {
  it('stores the record and emits neris.entity.synced with only the registered units', async () => {
    const send = vi.fn().mockResolvedValue({});
    await saveEntityRecord(
      { send } as unknown as DynamoDBDocumentClient,
      'platform-table',
      toVerifiedDeptId({ deptId: 'NICHOLS' }),
      {
        departmentNerisId: ENTITY,
        stations: [],
        units: [
          { unitId: 'E1', stationId: 'STA1', nerisId: `${ENTITY}S001U001`, status: 'CREATED' },
          { unitId: 'T2', stationId: 'STA1', status: 'FAILED' },
        ],
        errors: [],
        syncedAt: NOW.toISOString(),
        syncedBy: 'MBR-0001',
      },
      'trace',
    );
    const items = (
      send.mock.calls[0]![0] as {
        input: { TransactItems: { Put: { Item: Record<string, unknown> } }[] };
      }
    ).input.TransactItems.map((i) => i.Put.Item);
    expect(items[0]).toMatchObject({ pk: 'DEPT#NICHOLS', sk: 'NERIS#ENTITY' });
    expect(items[1]).toMatchObject({
      eventType: 'neris.entity.synced',
      source: 'platform-service',
      payload: {
        deptId: 'NICHOLS',
        departmentNerisId: ENTITY,
        units: [{ unitId: 'E1', stationId: 'STA1', nerisId: `${ENTITY}S001U001` }],
      },
    });
  });
});

describe('syncEntity: idempotent create (round 2, N9)', () => {
  it('adopts a station and unit NERIS already holds under our ids instead of creating them again', async () => {
    const { api, fns } = fakeApi({
      getEntity: vi.fn().mockResolvedValue({
        ok: true,
        httpStatus: 200,
        stations: [
          {
            nerisId: `${ENTITY}S001`,
            stationId: 'STA1',
            units: [{ nerisId: `${ENTITY}S001U001`, cadDesignation: 'E1' }],
          },
        ],
      }),
      createUnit: vi
        .fn()
        .mockResolvedValue({ ok: true, httpStatus: 201, nerisId: `${ENTITY}S001U002` }),
    });
    const record = await syncEntity(api, ENTITY, REQUEST, undefined, 'chief-1', NOW);
    expect(fns.getEntity).toHaveBeenCalledTimes(1);
    expect(fns.createStation).not.toHaveBeenCalled();
    expect(fns.patchStation).toHaveBeenCalledWith(ENTITY, `${ENTITY}S001`, expect.anything());
    expect(fns.patchUnit).toHaveBeenCalledWith(
      ENTITY,
      `${ENTITY}S001`,
      `${ENTITY}S001U001`,
      expect.anything(),
    );
    expect(fns.createUnit).toHaveBeenCalledTimes(1);
    expect(record.units.map((u) => [u.unitId, u.nerisId, u.status])).toEqual([
      ['E1', `${ENTITY}S001U001`, 'UPDATED'],
      ['T2', `${ENTITY}S001U002`, 'CREATED'],
    ]);
  });

  it('registers nothing new when NERIS cannot be asked what it already holds', async () => {
    const { api, fns } = fakeApi({
      getEntity: vi
        .fn()
        .mockResolvedValue({ ok: false, kind: 'server_error', httpStatus: 503, issues: [] }),
    });
    const record = await syncEntity(api, ENTITY, REQUEST, undefined, 'chief-1', NOW);
    expect(fns.createStation).not.toHaveBeenCalled();
    expect(fns.createUnit).not.toHaveBeenCalled();
    expect(record.errors[0]!.subject).toBe('NERIS entity');
  });

  it('does not ask NERIS when every station and unit already has its id', async () => {
    const { api, fns } = fakeApi();
    await syncEntity(
      api,
      ENTITY,
      REQUEST,
      {
        departmentNerisId: ENTITY,
        stations: [{ stationId: 'STA1', nerisId: `${ENTITY}S001`, status: 'CREATED' }],
        units: [
          { unitId: 'E1', stationId: 'STA1', nerisId: `${ENTITY}S001U001`, status: 'CREATED' },
          { unitId: 'T2', stationId: 'STA1', nerisId: `${ENTITY}S001U002`, status: 'CREATED' },
        ],
      },
      'chief-1',
      NOW,
    );
    expect(fns.getEntity).not.toHaveBeenCalled();
  });

  it('saves only over the sync it ran for, and reports a superseded save as stale (round 2c, Q4)', async () => {
    const { TransactionCanceledException } = await import('@aws-sdk/client-dynamodb');
    const record = {
      departmentNerisId: ENTITY,
      stations: [],
      units: [],
      errors: [],
      syncedAt: NOW.toISOString(),
      syncedBy: 'MBR-0001',
    };
    const send = vi.fn().mockRejectedValue(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );
    await expect(
      saveEntityRecord(
        { send } as unknown as DynamoDBDocumentClient,
        'platform-table',
        toVerifiedDeptId({ deptId: 'NICHOLS' }),
        record,
        'trace',
        't1',
      ),
    ).resolves.toBe('stale');
    const put = (
      send.mock.calls[0]![0] as { input: { TransactItems: { Put: Record<string, unknown> }[] } }
    ).input.TransactItems[0]!.Put;
    expect(put).toMatchObject({
      ConditionExpression: 'syncStatus = :syncing AND syncStartedAt = :started',
      ExpressionAttributeValues: { ':syncing': 'SYNCING', ':started': 't1' },
    });
  });
});
