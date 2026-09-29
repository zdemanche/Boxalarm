import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNerisClient } from './client.js';
import { createNerisApi, type NerisApi } from './api.js';
import { createTokenCache } from './tokenCache.js';
import {
  PAYLOAD_ROOT,
  findUndeclaredKeys,
  validateNode,
  type CompiledNerisSchema,
} from './apiSchema.js';
import { buildNerisIncidentPayload } from './payload.js';
import type { Incident } from '../entity.js';
import compiled from './fixtures/neris-api-1.5.1.json' with { type: 'json' };

const SCHEMA = compiled as unknown as CompiledNerisSchema;

/**
 * The fake validates like NERIS does (pydantic, `additionalProperties: false`): the payload
 * against the compiled NERIS 1.5.1 schema — required fields, every enum (incident types
 * included) and undeclared keys at any depth — so a test cannot pass on a payload NERIS
 * would 422.
 */
function nerisDetail(payload: unknown): { loc: (string | number)[]; msg: string; type: string }[] {
  const loc = (path: string): (string | number)[] => [
    'body',
    ...path
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .filter(Boolean)
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
  ];
  const root = { k: 'ref', n: PAYLOAD_ROOT } as const;
  return [
    ...findUndeclaredKeys(SCHEMA, root, payload).map((path) => ({
      loc: loc(path),
      msg: 'Extra inputs are not permitted',
      type: 'extra_forbidden',
    })),
    ...validateNode(SCHEMA, root, payload).map((issue) => ({
      loc: loc(issue.path),
      msg:
        issue.code === 'required'
          ? 'Field required'
          : issue.code === 'enum'
            ? 'Input should be a valid enum member'
            : 'Input should be a valid value',
      type: issue.code === 'required' ? 'missing' : issue.code === 'enum' ? 'enum' : 'type_error',
    })),
  ];
}

/**
 * The NERIS client against a local fake NERIS server that implements the paths, auth and
 * status codes of the NERIS OpenAPI (v1.4.78 prod / v1.5.1 test, identical paths): a `/v1`
 * server prefix, POST /token with HTTP Basic client credentials, Bearer auth plus a
 * mandatory User-Agent on every call (the real WAF answers 403 without one), and FastAPI
 * `{detail: [{loc, msg, type}]}` 422 bodies.
 */

const ENTITY = 'FD09190828';
const NERIS_ID = `${ENTITY}|4471|1798000000`;
const CLIENT_ID = 'boxalarm-dev';
const CLIENT_SECRET = 's3cret';
const USER_AGENT = 'Boxalarm/dev';
const TOKEN = 'fake-access-token';

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

let server: Server;
let baseUrl: string;
const requests: Recorded[] = [];

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function invalid(res: ServerResponse, loc: (string | number)[], msg: string, type = 'missing') {
  send(res, 422, { detail: [{ loc, msg, type }] });
}

function route(req: Recorded, res: ServerResponse): void {
  if (!req.headers['user-agent']?.startsWith('Boxalarm/')) {
    return send(res, 403, { message: 'Forbidden' });
  }
  const url = new URL(req.url, 'http://fake');
  const path = url.pathname;
  if (!path.startsWith('/v1/')) {
    return send(res, 404, { detail: 'Not Found' });
  }
  const rest = path.slice(3);

  if (req.method === 'POST' && rest === '/token') {
    const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
    if (
      req.headers.authorization !== expected ||
      !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded') ||
      new URLSearchParams(req.body).get('grant_type') !== 'client_credentials'
    ) {
      return send(res, 401, { error: 'invalid_client' });
    }
    return send(res, 200, { access_token: TOKEN, expires_in: 3600, token_type: 'Bearer' });
  }

  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(res, 401, { detail: 'Not authenticated' });
  }

  const payload = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
  const segments = rest.split('/').filter(Boolean).map(decodeURIComponent);

  if (segments[0] === 'incident' && segments.length === 3 && segments[2] === 'validate') {
    if (req.method !== 'POST') return send(res, 405);
    const detail = nerisDetail(payload);
    return detail.length === 0 ? send(res, 204) : send(res, 422, { detail });
  }
  if (segments[0] === 'incident' && segments.length === 2 && req.method === 'POST') {
    if (!/^(FD|VN|FM|FA)\d{8}$/.test(segments[1]!)) return send(res, 422, { detail: 'bad entity' });
    const detail = nerisDetail(payload);
    if (detail.length > 0) return send(res, 422, { detail });
    return send(res, 201, {
      neris_id: NERIS_ID,
      incident_status: { status: 'SUBMITTED', last_modified: '2026-09-29T10:00:00Z' },
    });
  }
  if (segments[0] === 'incident' && segments.length === 3 && segments[2] === NERIS_ID) {
    if (req.method === 'PUT') return send(res, 200, { last_modified: '2026-09-29T11:00:00Z' });
    if (req.method === 'GET') {
      return send(res, 200, {
        neris_id: NERIS_ID,
        incident_status: { status: 'REJECTED', last_modified: '2026-09-29T12:00:00Z' },
      });
    }
  }
  if (segments[0] === 'incident' && segments[3] === 'history' && req.method === 'GET') {
    return send(res, 200, {
      history: [
        { status: 'SUBMITTED', current: false, last_modified: '2026-09-29T10:00:00Z' },
        { status: 'PENDING_APPROVAL', current: true, last_modified: '2026-09-29T10:05:00Z' },
        { status: 'NOT_A_STATUS', current: false, last_modified: 'x' },
      ],
    });
  }
  if (rest === '/incident' && req.method === 'GET') {
    if (url.searchParams.get('neris_id_entity') !== ENTITY) return send(res, 422, { detail: [] });
    const cursor = url.searchParams.get('cursor');
    return send(res, 200, {
      incidents: cursor
        ? [{ neris_id: `${ENTITY}|4480|1798100000`, base: { incident_number: '4480' } }]
        : [
            {
              neris_id: NERIS_ID,
              base: { incident_number: '4471' },
              incident_status: { status: 'APPROVED' },
            },
          ],
      next_cursor: cursor ? null : 'page-2',
      prev_cursor: null,
    });
  }
  if (segments[0] === 'no_activity_report' && segments.length === 2 && req.method === 'POST') {
    if (!/^[0-1][0-9]\/20[2-9][0-9]$/.test(String(payload.month_year))) {
      return invalid(
        res,
        ['body', 'month_year'],
        'String should match pattern',
        'string_pattern_mismatch',
      );
    }
    return send(res, 201, { neris_uid: 'nar-1', month_year: payload.month_year });
  }
  if (segments[0] === 'entity' && segments[2] === 'station' && req.method === 'POST') {
    if (segments.length === 3) return send(res, 201, { neris_id: `${ENTITY}S001`, version: 1 });
    if (segments.length === 5 && segments[4] === 'unit') {
      return send(res, 201, { neris_id: `${ENTITY}S001U001`, version: 1 });
    }
  }
  if (segments[0] === 'entity' && req.method === 'PATCH') return send(res, 200, {});
  if (rest === '/busy') return send(res, 429, {});
  return send(res, 404, { detail: 'Not Found' });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: Recorded = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      route(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function api(userAgent = USER_AGENT, clientSecret = CLIENT_SECRET): NerisApi {
  return createNerisApi(
    createNerisClient(
      { baseUrl, userAgent, clientId: CLIENT_ID, clientSecret },
      { tokenCache: createTokenCache() },
    ),
  );
}

const CALL = '2026-09-29T14:02:11.000Z';
const PAYLOAD = {
  base: { department_neris_id: ENTITY, incident_number: '4471', location: { street: 'Main St' } },
  incident_types: [{ type: 'FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE', primary: true }],
  dispatch: {
    incident_number: '4471',
    call_arrival: CALL,
    call_answered: CALL,
    call_create: CALL,
    location: { street: 'Main St' },
    unit_responses: [],
  },
};

describe('NERIS client against a fake NERIS server', () => {
  beforeEach(() => {
    requests.length = 0;
  });

  it('gets a client_credentials token under /v1 and sends Bearer + User-Agent on the create', async () => {
    const result = await api().createIncident(ENTITY, PAYLOAD);

    expect(result).toEqual({ ok: true, httpStatus: 201, nerisId: NERIS_ID, status: 'SUBMITTED' });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /v1/token',
      `POST /v1/incident/${ENTITY}`,
    ]);
    const create = requests[1]!;
    expect(create.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(create.headers['user-agent']).toBe(USER_AGENT);
    expect(create.headers['content-type']).toBe('application/json');
    expect(JSON.parse(create.body)).toEqual(PAYLOAD);
  });

  it('maps a 422 create to a validation failure with flattened issue paths', async () => {
    const result = await api().createIncident(ENTITY, { base: {} });

    expect(result).toMatchObject({ ok: false, kind: 'validation', httpStatus: 422 });
    expect((result as unknown as { issues: unknown[] }).issues).toEqual(
      expect.arrayContaining([
        { path: 'dispatch', code: 'missing', message: 'Field required' },
        { path: 'base.incident_number', code: 'missing', message: 'Field required' },
      ]),
    );
  });

  it('rejects a local incident-type code that is not a NERIS TypeIncidentValue', async () => {
    const result = await api().validateIncident(ENTITY, {
      ...PAYLOAD,
      incident_types: [{ type: 'STRUCTURE_FIRE', primary: true }],
    });
    expect(result).toMatchObject({
      ok: false,
      kind: 'validation',
      issues: [{ path: 'incident_types[0].type', code: 'enum' }],
    });
  });

  it('rejects undeclared keys at any depth (additionalProperties: false)', async () => {
    const result = await api().validateIncident(ENTITY, {
      ...PAYLOAD,
      base: { ...PAYLOAD.base, internal_note: 'x' },
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [{ path: 'base.internal_note', code: 'extra_forbidden' }],
    });
  });

  it('accepts a payload built from a NERIS-typed report by the payload builder', async () => {
    const incident = {
      incidentId: 'NICHOLS-4471-1798000000',
      deptId: 'NICHOLS',
      dispatchNumber: '4471',
      epochSeconds: 1_798_000_000,
      nerisSchemaVersion: '2026.2+neris-1.5.1',
      corePayload: {
        incident_type: 'FIRE||OUTSIDE_FIRE||DUMPSTER_OUTDOOR_CONTAINER_FIRE',
      },
      address: '12 Main St, Trumbull, CT 06611',
      alarmAt: 1_798_000_000,
      narrative: 'Dumpster fire.',
      status: 'DRAFT',
      sourceDispatchId: 'NICHOLS-4471-1798000000',
      createdBy: 'MBR-0034',
      createdAt: 1_798_000_000,
      updatedAt: 1_798_000_000,
    } as Incident;
    const payload = buildNerisIncidentPayload({
      incident,
      units: [{ unitId: 'E1', unitType: 'APPARATUS', dispatchedAt: 1_798_000_060 }],
      departmentNerisId: ENTITY,
      unitNerisIds: {},
      schema: SCHEMA,
    });
    await expect(api().validateIncident(ENTITY, payload)).resolves.toEqual({
      ok: true,
      httpStatus: 204,
    });
  });

  it('validate: 204 is valid and nothing is created; 422 carries the issues', async () => {
    await expect(api().validateIncident(ENTITY, PAYLOAD)).resolves.toEqual({
      ok: true,
      httpStatus: 204,
    });
    const invalidResult = await api().validateIncident(ENTITY, { base: {} });
    expect(invalidResult).toMatchObject({ ok: false, kind: 'validation', httpStatus: 422 });
    expect(requests.filter((r) => r.url.endsWith('/validate'))).toHaveLength(2);
    expect(requests.some((r) => r.url === `/v1/incident/${ENTITY}`)).toBe(false);
  });

  it('replaces and reads by NERIS id with the pipes percent-encoded in the path', async () => {
    const client = api();
    await expect(client.replaceIncident(ENTITY, NERIS_ID, PAYLOAD)).resolves.toEqual({
      ok: true,
      httpStatus: 200,
      lastModified: '2026-09-29T11:00:00Z',
    });
    await expect(client.getIncidentStatus(ENTITY, NERIS_ID)).resolves.toEqual({
      ok: true,
      httpStatus: 200,
      status: 'REJECTED',
    });
    const encoded = `/v1/incident/${ENTITY}/${encodeURIComponent(NERIS_ID)}`;
    expect(requests.filter((r) => r.url === encoded).map((r) => r.method)).toEqual(['PUT', 'GET']);
  });

  it('reads the status history, dropping values outside TypeIncidentStatusValue', async () => {
    const result = await api().getIncidentHistory(ENTITY, NERIS_ID);

    expect(result).toEqual({
      ok: true,
      httpStatus: 200,
      history: [
        { status: 'SUBMITTED', current: false, lastModified: '2026-09-29T10:00:00Z' },
        { status: 'PENDING_APPROVAL', current: true, lastModified: '2026-09-29T10:05:00Z' },
      ],
    });
  });

  it('lists every page of the department incidents by cursor', async () => {
    const result = await api().listIncidents(ENTITY);

    expect(result).toEqual({
      ok: true,
      httpStatus: 200,
      truncated: false,
      incidents: [
        { nerisId: NERIS_ID, incidentNumber: '4471', status: 'APPROVED' },
        { nerisId: `${ENTITY}|4480|1798100000`, incidentNumber: '4480' },
      ],
    });
    const lists = requests.filter((r) => r.url.startsWith('/v1/incident?'));
    expect(lists).toHaveLength(2);
    expect(lists[0]!.url).toContain('page_size=100');
    expect(lists[1]!.url).toContain('cursor=page-2');
  });

  it('files a no-activity report as MM/YYYY and surfaces a pattern 422', async () => {
    await expect(api().createNoActivityReport(ENTITY, '08/2026')).resolves.toEqual({
      ok: true,
      httpStatus: 201,
      nerisUid: 'nar-1',
    });
    await expect(api().createNoActivityReport(ENTITY, '2026-08')).resolves.toMatchObject({
      ok: false,
      kind: 'validation',
      issues: [{ path: 'month_year', code: 'string_pattern_mismatch' }],
    });
  });

  it('creates a station, then a unit under it, and patches both', async () => {
    const client = api();
    const station = await client.createStation(ENTITY, { station_id: 'STA1' });
    expect(station).toEqual({ ok: true, httpStatus: 201, nerisId: `${ENTITY}S001` });
    const unit = await client.createUnit(ENTITY, `${ENTITY}S001`, { cad_designation_1: 'E1' });
    expect(unit).toEqual({ ok: true, httpStatus: 201, nerisId: `${ENTITY}S001U001` });
    await expect(client.patchStation(ENTITY, `${ENTITY}S001`, {})).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      client.patchUnit(ENTITY, `${ENTITY}S001`, `${ENTITY}S001U001`, {}),
    ).resolves.toMatchObject({ ok: true });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toContain(
      `POST /v1/entity/${ENTITY}/station/${ENTITY}S001/unit`,
    );
  });

  it('bad client credentials fail at the token endpoint and never reach an incident path', async () => {
    await expect(api(USER_AGENT, 'wrong').createIncident(ENTITY, PAYLOAD)).rejects.toThrow(
      /HTTP 401/,
    );
    expect(requests.map((r) => r.url)).toEqual(['/v1/token']);
  });

  it('classifies statuses: 403 client_error, 404 client_error, 429 rate_limited', async () => {
    const client = createNerisClient(
      { baseUrl, userAgent: USER_AGENT, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      { tokenCache: createTokenCache() },
    );
    const busy = await client.fetch('/busy');
    expect(busy.status).toBe(429);
    const { failureKind } = await import('./api.js');
    expect(failureKind(403)).toBe('client_error');
    expect(failureKind(404)).toBe('client_error');
    expect(failureKind(429)).toBe('rate_limited');
    expect(failureKind(422)).toBe('validation');
    expect(failureKind(502)).toBe('server_error');
  });
});
