import type { ProblemDetails } from '../../lib/apiClient';
import type { CreateIncidentInput, Incident } from './types';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function problem(status: number, title: string): Response {
  const body: ProblemDetails = { type: 'about:blank', title, status, traceId: 'demo' };
  return json(body, status);
}

const nowSeconds = Math.floor(Date.now() / 1000);
const daysAgo = (days: number) => nowSeconds - days * 86400;

// Nichols FD tenant-zero incident history. Fixture data for the demo build only.
let incidents: Incident[] = [
  {
    incidentId: 'i-1',
    deptId: 'nichols-fd',
    dispatchNumber: '26-001841',
    epochSeconds: daysAgo(40),
    nerisSchemaVersion: 'UNVALIDATED',
    corePayload: {},
    incidentType: 'Structure fire',
    address: '14 Elm St, Trumbull, CT',
    alarmAt: daysAgo(40),
    dispatchAt: daysAgo(40) + 30,
    narrative: 'Working fire, first floor kitchen, extinguished on arrival of Engine 301.',
    status: 'VALIDATED',
    sourceDispatchId: 'd-100',
    createdBy: 'm-1',
    createdAt: daysAgo(40),
    updatedAt: daysAgo(39),
  },
  {
    incidentId: 'i-2',
    deptId: 'nichols-fd',
    dispatchNumber: '26-002014',
    epochSeconds: daysAgo(10),
    nerisSchemaVersion: 'UNVALIDATED',
    corePayload: {},
    incidentType: 'Motor vehicle accident',
    address: 'Route 111 & Daniels Farm Rd, Trumbull, CT',
    alarmAt: daysAgo(10),
    dispatchAt: daysAgo(10) + 90,
    narrative: 'Two-vehicle MVA, extrication not required.',
    status: 'DRAFT',
    sourceDispatchId: 'd-101',
    createdBy: 'm-2',
    createdAt: daysAgo(10),
    updatedAt: daysAgo(10),
  },
];

// Seeded live dispatch — pre-population source for the create-from-dispatch flow (E6-S2-UI).
// Roster/apparatus values match the Nichols FD tenant-zero fleet used across every demo fixture.
const seededDispatches: Record<
  string,
  Pick<Incident, 'incidentType' | 'address' | 'narrative' | 'alarmAt' | 'dispatchAt'>
> = {
  'd-1': {
    incidentType: 'Structure fire',
    address: '212 Church Hill Rd, Trumbull, CT',
    narrative: 'Smoke showing on arrival, Engine 301 first-due, Truck 304 laddered the rear.',
    alarmAt: nowSeconds - 600,
    dispatchAt: nowSeconds - 570,
  },
};

function findById(incidentId: string): Incident | undefined {
  return incidents.find((i) => i.incidentId === incidentId);
}

export async function incidentsDemoRequest(
  path: string,
  method: string,
  body: Record<string, unknown>,
  query: URLSearchParams,
): Promise<Response | undefined> {
  const parts = path.split('/');
  if (parts[0] !== 'incidents') return undefined;

  if (path === 'incidents' && method === 'GET') {
    const from = Number(query.get('fromAlarmAt'));
    const to = Number(query.get('toAlarmAt'));
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return problem(400, 'fromAlarmAt and toAlarmAt are required');
    }
    if (from > to) return problem(400, 'fromAlarmAt must not be after toAlarmAt');
    const inRange = incidents
      .filter((i) => (i.alarmAt ?? 0) >= from && (i.alarmAt ?? 0) <= to)
      .sort((a, b) => (a.alarmAt ?? 0) - (b.alarmAt ?? 0));
    return json({ incidents: inRange });
  }

  if (path === 'incidents' && method === 'POST') {
    const input = body as unknown as CreateIncidentInput;
    const seed = seededDispatches[input.dispatchId];
    if (!seed) return problem(404, 'Dispatch not found');
    const created: Incident = {
      incidentId: `i-${incidents.length + 1}`,
      deptId: 'nichols-fd',
      dispatchNumber: `26-${2000 + incidents.length}`,
      epochSeconds: nowSeconds,
      nerisSchemaVersion: 'UNVALIDATED',
      corePayload: {},
      ...seed,
      status: 'DRAFT',
      sourceDispatchId: input.dispatchId,
      createdBy: 'demo-user',
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
    };
    incidents = [...incidents, created];
    return json(created, 201);
  }

  if (parts.length === 2 && method === 'GET') {
    const found = findById(decodeURIComponent(parts[1] ?? ''));
    return found ? json(found) : problem(404, 'Incident not found');
  }

  return problem(404, 'Not found');
}
