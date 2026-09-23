import { apparatusDemoRequest } from '../features/apparatus/demoFixtures';
import type { CreateMemberInput, Member, MemberStatus } from '../features/personnel/types';
import type { ApiRequestOptions, ProblemDetails } from './apiClient';

let members: Member[] = [
  {
    memberId: 'm-1',
    firstName: 'Alex',
    lastName: 'Rivera',
    email: 'arivera@nicholsfd.org',
    phone: '203-555-0111',
    status: 'ACTIVE',
    joinDate: '2018-04-12',
    rank: 'Chief',
    agencyId: 'nichols-fd',
  },
  {
    memberId: 'm-2',
    firstName: 'Jordan',
    lastName: 'Osei',
    email: 'josei@nicholsfd.org',
    phone: '203-555-0122',
    status: 'ACTIVE',
    joinDate: '2015-09-01',
    rank: 'Deputy Chief',
    agencyId: 'nichols-fd',
  },
  {
    memberId: 'm-3',
    firstName: 'Casey',
    lastName: 'Nolan',
    email: 'cnolan@nicholsfd.org',
    phone: '203-555-0133',
    status: 'ACTIVE',
    joinDate: '2019-06-20',
    rank: 'Captain',
    agencyId: 'nichols-fd',
  },
  {
    memberId: 'm-4',
    firstName: 'Priya',
    lastName: 'Shah',
    email: 'pshah@nicholsfd.org',
    phone: '203-555-0144',
    status: 'PROBATIONARY',
    joinDate: '2025-11-03',
    rank: 'Firefighter',
    agencyId: 'nichols-fd',
  },
  {
    memberId: 'm-5',
    firstName: 'Miguel',
    lastName: 'Torres',
    email: 'mtorres@nicholsfd.org',
    phone: '203-555-0155',
    status: 'LOA',
    joinDate: '2012-02-14',
    rank: 'Firefighter',
    agencyId: 'nichols-fd',
  },
];

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

export async function demoRequest(
  path: string,
  options: ApiRequestOptions = {},
): Promise<Response> {
  const method = (options.method ?? 'GET').toUpperCase();
  const body = options.body ? (JSON.parse(options.body as string) as Record<string, unknown>) : {};
  const parts = path.split('/');

  if (parts[0] === 'apparatus') {
    const response = await apparatusDemoRequest(path, method, body);
    if (response) return response;
  }

  if (path === 'personnel/members' && method === 'GET') return json({ items: members });

  if (path === 'personnel/members' && method === 'POST') {
    const input = body as unknown as CreateMemberInput;
    const created: Member = {
      memberId: `m-${members.length + 1}`,
      status: 'PROBATIONARY',
      ...input,
    };
    members = [...members, created];
    return json(created, 201);
  }

  if (
    parts[0] === 'personnel' &&
    parts[1] === 'members' &&
    parts.length === 3 &&
    method === 'GET'
  ) {
    const found = members.find((m) => m.memberId === decodeURIComponent(parts[2] ?? ''));
    return found ? json(found) : problem(404, 'Member not found');
  }

  if (
    parts[0] === 'personnel' &&
    parts[1] === 'members' &&
    parts[3] === 'status' &&
    method === 'PUT'
  ) {
    const id = decodeURIComponent(parts[2] ?? '');
    const status = (body as { status: MemberStatus }).status;
    let updated: Member | undefined;
    members = members.map((m) => {
      if (m.memberId !== id) return m;
      updated = { ...m, status };
      return updated;
    });
    return updated ? json(updated) : problem(404, 'Member not found');
  }

  return problem(404, 'Not found');
}
