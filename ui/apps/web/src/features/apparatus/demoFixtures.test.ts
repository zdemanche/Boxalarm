import { expect, test } from 'vitest';
import { DEMO_FLEET } from '../../lib/demoRoster';
import { apparatusDemoRequest } from './demoFixtures';

// The registry is the shared demo fleet, so the riding board, incidents and reports all name
// the same units; Truck 304 is the one down, for the reason the alerting fixtures also carry.
test('registry lists the shared demo fleet with Truck 304 out of service', async () => {
  const response = await apparatusDemoRequest('apparatus', 'GET', {});
  const body = (await response?.json()) as {
    apparatus: { apparatusId: string; unitId: string; status: string; outOfService?: unknown }[];
  };
  expect(body.apparatus.map((a) => [a.apparatusId, a.unitId])).toEqual(
    DEMO_FLEET.map((unit) => [unit.apparatusId, unit.unitId]),
  );
  const truck = body.apparatus.find((a) => a.unitId === 'Truck 304');
  expect(truck?.status).toBe('OUT_OF_SERVICE');
  expect(truck?.outOfService).toMatchObject({ reason: 'Aerial hydraulic leak' });
});

test('compliance covers every unit, with a weekly cadence for utility and brush', async () => {
  const response = await apparatusDemoRequest('apparatus/compliance?from=0&to=1', 'GET', {});
  const body = (await response?.json()) as {
    report: { unitId: string; expectedChecks: number; actualChecks: number }[];
  };
  expect(body.report.map((r) => r.unitId)).toEqual(DEMO_FLEET.map((unit) => unit.unitId));
  expect(body.report.find((r) => r.unitId === 'Utility 302')?.expectedChecks).toBe(1);
  expect(body.report.find((r) => r.unitId === 'Engine 301')?.expectedChecks).toBe(7);
  for (const row of body.report) expect(row.actualChecks).toBeLessThanOrEqual(row.expectedChecks);
});

// The demo fixture must resolve each path segment by the same identifier the real
// apparatus-service handler does, or the demo hides live-mode 404s (PR #321 review C2).

test('detail GET resolves by display unitId, like backend getApparatus.ts', async () => {
  const byUnitId = await apparatusDemoRequest(
    `apparatus/${encodeURIComponent('Engine 301')}`,
    'GET',
    {},
  );
  expect(byUnitId?.status).toBe(200);
  const byApparatusId = await apparatusDemoRequest('apparatus/a-2', 'GET', {});
  expect(byApparatusId?.status).toBe(404);
});

test('service-status PUT resolves by display unitId', async () => {
  const response = await apparatusDemoRequest(
    `apparatus/${encodeURIComponent('Squad 309')}/service-status`,
    'PUT',
    { status: 'IN_SERVICE' },
  );
  expect(response?.status).toBe(204);
});

test('maintenance and inventory resolve by apparatusId (the partition key)', async () => {
  const maintenance = await apparatusDemoRequest('apparatus/a-2/maintenance', 'GET', {});
  expect(maintenance?.status).toBe(200);
  const inventory = await apparatusDemoRequest('apparatus/a-2/inventory', 'GET', {});
  expect(inventory?.status).toBe(200);
});

test('SCBA POST resolves by unitId and records the resolved apparatusId', async () => {
  const response = await apparatusDemoRequest(
    `apparatus/${encodeURIComponent('Engine 301')}/scba`,
    'POST',
    {
      scbaUnitId: 'SCBA-1',
      cylinderId: 'C-1',
      flowTestDate: '2026-01-01',
      hydroTestDate: '2026-01-01',
    },
  );
  expect(response?.status).toBe(201);
  expect(((await response?.json()) as { apparatusId: string }).apparatusId).toBe('a-2');
});
