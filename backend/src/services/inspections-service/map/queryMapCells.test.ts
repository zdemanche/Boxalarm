import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { queryMapCells } from './queryMapCells.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-001' });

function fakeDoc(
  responder: (input: { ExpressionAttributeValues: { ':cellKey': string } }) => {
    Items?: Record<string, unknown>[];
  },
): DynamoDBDocumentClient {
  return {
    send: vi.fn((command: { input: { ExpressionAttributeValues: { ':cellKey': string } } }) =>
      Promise.resolve(responder(command.input)),
    ),
  } as unknown as DynamoDBDocumentClient;
}

describe('queryMapCells', () => {
  it('issues an OCCUPANCY and a HYDRANT query per cell and merges results across cells (AC1, AC4)', async () => {
    const occupancyA = {
      pk: 'DEPT#dept-001#OCCUPANCY#occ-a',
      latitude: 41.24,
      longitude: -73.2,
      gsi3pk: 'DEPT#dept-001#OCCUPANCY#GEO#dr5ru',
      gsi3sk: 'dr5ru123#occ-a',
    };
    const hydrantA = {
      pk: 'DEPT#dept-001#HYDRANT#hyd-a',
      latitude: 41.25,
      longitude: -73.19,
      status: 'IN_SERVICE',
      gsi3pk: 'DEPT#dept-001#HYDRANT#GEO#dr5rv',
      gsi3sk: 'dr5rv456#hyd-a',
    };
    const send = vi.fn(
      (command: { input: { ExpressionAttributeValues: { ':cellKey': string } } }) => {
        const key = command.input.ExpressionAttributeValues[':cellKey'];
        if (key.includes('OCCUPANCY') && key.includes('dr5ru')) {
          return Promise.resolve({ Items: [occupancyA] });
        }
        if (key.includes('HYDRANT') && key.includes('dr5rv')) {
          return Promise.resolve({ Items: [hydrantA] });
        }
        return Promise.resolve({ Items: [] });
      },
    );
    const doc = { send } as unknown as DynamoDBDocumentClient;

    const result = await queryMapCells(doc, 'platform-table', DEPT_ID, ['dr5ru', 'dr5rv']);

    expect(send).toHaveBeenCalledTimes(4);
    expect(result.occupancies).toEqual([
      {
        occupancyId: 'occ-a',
        latitude: 41.24,
        longitude: -73.2,
        gsi3pk: occupancyA.gsi3pk,
        gsi3sk: occupancyA.gsi3sk,
      },
    ]);
    expect(result.hydrants).toEqual([
      {
        hydrantId: 'hyd-a',
        latitude: 41.25,
        longitude: -73.19,
        status: 'IN_SERVICE',
        gsi3pk: hydrantA.gsi3pk,
        gsi3sk: hydrantA.gsi3sk,
      },
    ]);
  });

  it('deduplicates by pk when the same item is returned by two cells (AC4, core-harm)', async () => {
    const occupancy = {
      pk: 'DEPT#dept-001#OCCUPANCY#occ-dup',
      latitude: 41.24,
      longitude: -73.2,
      gsi3pk: 'DEPT#dept-001#OCCUPANCY#GEO#dr5ru',
      gsi3sk: 'dr5ru123#occ-dup',
    };
    const doc = fakeDoc(() => ({ Items: [occupancy] }));

    const result = await queryMapCells(doc, 'platform-table', DEPT_ID, ['dr5ru', 'dr5ru']);

    expect(result.occupancies).toHaveLength(1);
  });

  it('scopes every query to the caller-verified deptId via buildDeptScopedPk (dept-scoping)', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const doc = { send } as unknown as DynamoDBDocumentClient;

    await queryMapCells(doc, 'platform-table', DEPT_ID, ['dr5ru']);

    for (const call of send.mock.calls) {
      const command = call[0] as { input: { ExpressionAttributeValues: { ':cellKey': string } } };
      expect(command.input.ExpressionAttributeValues[':cellKey']).toMatch(/^DEPT#dept-001#/);
    }
  });

  it('carries hydrant status through unstripped so out-of-service hydrants stay distinguishable (AC3)', async () => {
    const hydrant = {
      pk: 'DEPT#dept-001#HYDRANT#hyd-oos',
      latitude: 41.24,
      longitude: -73.2,
      status: 'OUT_OF_SERVICE',
      gsi3pk: 'DEPT#dept-001#HYDRANT#GEO#dr5ru',
      gsi3sk: 'dr5ru123#hyd-oos',
    };
    const doc = fakeDoc((input) =>
      input.ExpressionAttributeValues[':cellKey'].includes('HYDRANT')
        ? { Items: [hydrant] }
        : { Items: [] },
    );

    const result = await queryMapCells(doc, 'platform-table', DEPT_ID, ['dr5ru']);

    expect(result.hydrants[0]?.status).toBe('OUT_OF_SERVICE');
  });

  it('paginates a cell query on LastEvaluatedKey until exhausted, merging both pages (silent-truncation fix, P3)', async () => {
    const pageOne = {
      pk: 'DEPT#dept-001#OCCUPANCY#occ-p1',
      latitude: 41.24,
      longitude: -73.2,
      gsi3pk: 'DEPT#dept-001#OCCUPANCY#GEO#dr5ru',
      gsi3sk: 'dr5ru001#occ-p1',
    };
    const pageTwo = {
      pk: 'DEPT#dept-001#OCCUPANCY#occ-p2',
      latitude: 41.241,
      longitude: -73.201,
      gsi3pk: 'DEPT#dept-001#OCCUPANCY#GEO#dr5ru',
      gsi3sk: 'dr5ru002#occ-p2',
    };
    const send = vi.fn(
      (command: {
        input: {
          ExpressionAttributeValues: { ':cellKey': string };
          ExclusiveStartKey?: unknown;
        };
      }) => {
        const key = command.input.ExpressionAttributeValues[':cellKey'];
        if (!key.includes('OCCUPANCY')) {
          return Promise.resolve({ Items: [] });
        }
        if (!command.input.ExclusiveStartKey) {
          return Promise.resolve({ Items: [pageOne], LastEvaluatedKey: { pk: pageOne.pk } });
        }
        return Promise.resolve({ Items: [pageTwo] });
      },
    );
    const doc = { send } as unknown as DynamoDBDocumentClient;

    const result = await queryMapCells(doc, 'platform-table', DEPT_ID, ['dr5ru']);

    expect(result.occupancies.map((o) => o.occupancyId).sort()).toEqual(['occ-p1', 'occ-p2']);
  });

  it('skips an item with a non-finite latitude/longitude instead of emitting NaN/null markers (P8)', async () => {
    const badOccupancy = {
      pk: 'DEPT#dept-001#OCCUPANCY#occ-bad',
      gsi3pk: 'DEPT#dept-001#OCCUPANCY#GEO#dr5ru',
      gsi3sk: 'dr5ru123#occ-bad',
    };
    const doc = fakeDoc((input) =>
      input.ExpressionAttributeValues[':cellKey'].includes('OCCUPANCY')
        ? { Items: [badOccupancy] }
        : { Items: [] },
    );

    const result = await queryMapCells(doc, 'platform-table', DEPT_ID, ['dr5ru']);

    expect(result.occupancies).toHaveLength(0);
  });

  it('skips a hydrant whose status is not IN_SERVICE/OUT_OF_SERVICE instead of emitting the literal string "undefined" (P8)', async () => {
    const badHydrant = {
      pk: 'DEPT#dept-001#HYDRANT#hyd-bad',
      latitude: 41.24,
      longitude: -73.2,
      gsi3pk: 'DEPT#dept-001#HYDRANT#GEO#dr5ru',
      gsi3sk: 'dr5ru123#hyd-bad',
    };
    const doc = fakeDoc((input) =>
      input.ExpressionAttributeValues[':cellKey'].includes('HYDRANT')
        ? { Items: [badHydrant] }
        : { Items: [] },
    );

    const result = await queryMapCells(doc, 'platform-table', DEPT_ID, ['dr5ru']);

    expect(result.hydrants).toHaveLength(0);
  });

  it('excludes PII fields (address, contacts) from the projected occupancy — only geo/id fields pass through (sensitive-data-handling)', async () => {
    const occupancy = {
      pk: 'DEPT#dept-001#OCCUPANCY#occ-pii',
      latitude: 41.24,
      longitude: -73.2,
      address: '123 Main St',
      normalizedAddress: '123 MAIN ST',
      contacts: [{ name: 'Owner', phone: '555-1234' }],
      gsi3pk: 'DEPT#dept-001#OCCUPANCY#GEO#dr5ru',
      gsi3sk: 'dr5ru123#occ-pii',
    };
    const doc = fakeDoc((input) =>
      input.ExpressionAttributeValues[':cellKey'].includes('OCCUPANCY')
        ? { Items: [occupancy] }
        : { Items: [] },
    );

    const result = await queryMapCells(doc, 'platform-table', DEPT_ID, ['dr5ru']);

    expect(Object.keys(result.occupancies[0] ?? {}).sort()).toEqual(
      ['gsi3pk', 'gsi3sk', 'latitude', 'longitude', 'occupancyId'].sort(),
    );
  });
});
