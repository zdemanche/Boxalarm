import type { Apparatus, CreateApparatusInput } from '../features/apparatus/types';
import type { CreateMemberInput, Member, MemberStatus } from '../features/personnel/types';
import type {
  AuditEntry,
  ConfigResponse,
  DisposalResult,
  EditableConfigType,
  ExportStatus,
  RetentionConfig,
} from '../features/platform/types';
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

let apparatus: Apparatus[] = [
  { apparatusId: 'a-1', unitId: 'Engine 1', type: 'Engine', status: 'IN_SERVICE' },
  { apparatusId: 'a-2', unitId: 'Ladder 1', type: 'Ladder', status: 'IN_SERVICE' },
  { apparatusId: 'a-3', unitId: 'Rescue 1', type: 'Rescue', status: 'OUT_OF_SERVICE' },
  { apparatusId: 'a-4', unitId: 'Tanker 2', type: 'Tanker', status: 'IN_SERVICE' },
];

const configStore = new Map<EditableConfigType, ConfigResponse>([
  [
    'ALERT_RULES',
    {
      configType: 'ALERT_RULES',
      value: { escalationThresholdN: 90 },
      version: 1,
      updatedAt: '2026-08-01T00:00:00.000Z',
      updatedBy: 'demo-admin',
    },
  ],
]);

let retentionConfig: RetentionConfig = { retentionYears: 7, version: 1, source: 'stored' };

const auditEntries: AuditEntry[] = [
  {
    actorId: 'demo-admin',
    ts: Date.parse('2026-08-01T00:00:00.000Z'),
    action: 'UPDATE',
    mutatedEntityType: 'DEPARTMENT_CONFIG',
    mutatedEntityId: 'ALERT_RULES',
    changedFields: { escalationThresholdN: { old: 60, new: 90 } },
  },
];

let exportJobId = 0;

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

  if (path === 'apparatus' && method === 'GET') return json({ items: apparatus });

  if (path === 'apparatus' && method === 'POST') {
    const input = body as unknown as CreateApparatusInput;
    const created: Apparatus = {
      apparatusId: `a-${apparatus.length + 1}`,
      unitId: input.unitId,
      type: input.type,
      status: 'IN_SERVICE',
    };
    apparatus = [...apparatus, created];
    return json(created, 201);
  }

  if (parts[0] === 'apparatus' && parts.length === 2 && method === 'GET') {
    const found = apparatus.find((a) => a.apparatusId === decodeURIComponent(parts[1] ?? ''));
    return found ? json(found) : problem(404, 'Apparatus not found');
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

  if (parts[0] === 'platform' && parts[1] === 'config' && parts.length === 3) {
    const configType = decodeURIComponent(parts[2] ?? '') as EditableConfigType;
    if (method === 'GET') {
      const stored = configStore.get(configType);
      return stored ? json(stored) : problem(404, `config ${configType} not found`);
    }
    if (method === 'PUT') {
      const existing = configStore.get(configType);
      const nextVersion = (existing?.version ?? 0) + 1;
      const saved: ConfigResponse = {
        configType,
        value: (body as { value: Record<string, unknown> }).value,
        version: nextVersion,
        updatedAt: new Date().toISOString(),
        updatedBy: 'demo-admin',
      };
      configStore.set(configType, saved);
      return json(saved);
    }
  }

  if (path.startsWith('platform/audit') && method === 'GET') {
    return json({ entries: auditEntries });
  }

  if (path === 'platform/export' && method === 'POST') {
    exportJobId += 1;
    return json({ jobId: `demo-export-${exportJobId}` }, 202);
  }

  if (parts[0] === 'platform' && parts[1] === 'export' && parts.length === 3 && method === 'GET') {
    const status: ExportStatus = {
      status: 'COMPLETE',
      files: [{ table: 'members', url: '#demo-export-members' }],
    };
    return json(status);
  }

  if (path === 'platform/retention' && method === 'GET') {
    return json(retentionConfig);
  }

  if (path === 'platform/retention' && method === 'PUT') {
    const retentionYears = (body as { retentionYears: number }).retentionYears;
    retentionConfig = {
      retentionYears,
      version: (retentionConfig.version ?? 0) + 1,
      source: 'stored',
    };
    return json(retentionConfig);
  }

  if (path === 'platform/retention/disposal' && method === 'POST') {
    const result: DisposalResult = {
      retentionYearsUsed: retentionConfig.retentionYears,
      hardDeleted: 0,
      cryptoShredded: 0,
      refused: [],
    };
    return json(result);
  }

  if (path === 'platform/sessions/revoke' && method === 'POST') {
    const memberId = (body as { memberId: string }).memberId;
    return json({ memberId, status: 'revoked' }, 202);
  }

  return problem(404, 'Not found');
}
