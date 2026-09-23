import type { AttendanceRecord, LosapTotal, Qualification } from './types';

const quals: Record<string, Qualification[]> = {
  'm-1': [{ qualCode: 'OFFICER', grantedByCertId: null, currentlyEligible: true }],
  'm-3': [{ qualCode: 'INTERIOR', grantedByCertId: 'CERT-0091', currentlyEligible: true }],
};

const losap: Record<string, LosapTotal> = {};

let attendance: AttendanceRecord[] = [
  { activityType: 'DRILL', refId: null, occurredAt: 1758000000, hours: 2 },
];

export function tryHandlePersonnelExtras(
  parts: string[],
  method: string,
  body: Record<string, unknown>,
): Response | undefined {
  if (parts[0] !== 'personnel') return undefined;

  if (parts[1] === 'attendance') {
    if (method === 'GET') return json({ records: attendance });
    if (method === 'POST') {
      const record: AttendanceRecord = {
        activityType: body.activityType as AttendanceRecord['activityType'],
        refId: (body.refId as string | null) ?? null,
        occurredAt: body.occurredAt as number,
        hours: body.hours as number,
      };
      attendance = [...attendance, record];
      return json(record, 201);
    }
  }

  if (parts[1] === 'members' && parts[3] === 'quals') {
    const memberId = decodeURIComponent(parts[2] ?? '');
    if (method === 'GET') return json(quals[memberId] ?? []);
    if (method === 'PUT') {
      const qual: Qualification = {
        qualCode: body.qualCode as string,
        grantedByCertId: (body.grantedByCertId as string | null) ?? null,
        currentlyEligible: body.grantedByCertId === null || body.grantedByCertId === undefined,
      };
      quals[memberId] = [...(quals[memberId] ?? []), qual];
      return json(qual);
    }
  }

  if (parts[1] === 'members' && parts[3] === 'losap' && method === 'GET') {
    const memberId = decodeURIComponent(parts[2] ?? '');
    const total = losap[memberId] ?? { memberId, year: new Date().getFullYear(), totalPoints: 0 };
    return json(total);
  }

  return undefined;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
