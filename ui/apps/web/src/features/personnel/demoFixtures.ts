import type { AttendanceRecord, LosapTotal, Qualification } from './types';

const quals: Record<string, Qualification[]> = {
  'm-1': [{ qualCode: 'OFFICER', grantedByCertId: null, currentlyEligible: true }],
  'm-3': [{ qualCode: 'INTERIOR', grantedByCertId: 'CERT-0091', currentlyEligible: true }],
};

const losap: Record<string, LosapTotal> = {};

let attendance: AttendanceRecord[] = [
  { activityType: 'DRILL', refId: null, occurredAt: 1758000000, hours: 2 },
];

// One upcoming mark-off, so the list and Cancel are visible in demo mode without implying the
// demo member is unavailable right now.
const demoMarkOffStart = Math.floor(Date.now() / 1000) + 86_400;
let markOffs: { markoffId: string; startAt: number; endAt: number; reason?: string }[] = [
  {
    markoffId: String(demoMarkOffStart),
    startAt: demoMarkOffStart,
    endAt: demoMarkOffStart + 43_200,
    reason: 'Travel',
  },
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

  if (parts[1] === 'members' && parts[3] === 'availability' && parts.length === 4) {
    // Mirrors availability/handler.ts and markoffs.ts: markoffId is the startAt as a string.
    if (method === 'GET') return json({ markOffs });
    if (method === 'POST') {
      const startAt = body.startAt as number;
      markOffs = [
        ...markOffs,
        {
          markoffId: String(startAt),
          startAt,
          endAt: body.endAt as number,
          ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        },
      ].sort((a, b) => a.startAt - b.startAt);
      return json(
        {
          memberId: decodeURIComponent(parts[2] ?? ''),
          startAt: body.startAt,
          endAt: body.endAt,
          affectsAlerting: true,
          ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        },
        201,
      );
    }
  }

  if (
    parts[1] === 'members' &&
    parts[3] === 'availability' &&
    parts[5] === 'end' &&
    method === 'POST'
  ) {
    const markoffId = decodeURIComponent(parts[4] ?? '');
    const markOff = markOffs.find((m) => m.markoffId === markoffId);
    if (!markOff) return json({ type: 'about:blank', title: 'Not Found', status: 404 }, 404);
    const nowSeconds = Math.floor(Date.now() / 1000);
    markOffs = markOffs.filter((m) => m.markoffId !== markoffId);
    return json({ markoffId, endedAt: nowSeconds, cancelled: markOff.startAt > nowSeconds });
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
