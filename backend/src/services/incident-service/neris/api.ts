import type { NerisClient } from './client.js';
import {
  NERIS_LIST_PAGE_SIZE,
  NERIS_PATHS,
  isNerisIncidentStatus,
  type NerisIncidentStatus,
} from './paths.js';

/**
 * Typed NERIS operations over the shared {@link NerisClient} (which owns User-Agent and
 * the Bearer token). Paths and response shapes are pinned in paths.ts.
 *
 * Status mapping, uniform across operations:
 *   2xx          -> ok
 *   422          -> `validation`, with the FastAPI `detail[]` flattened to issues
 *   other 4xx    -> `client_error` (auth, WAF, not found) — never retried blindly
 *   429          -> `rate_limited`
 *   5xx / other  -> `server_error`
 */

export interface NerisIssue {
  /** Dotted path into the payload, e.g. `dispatch.call_create` (the leading `body` is dropped). */
  readonly path: string;
  /** NERIS/pydantic error type, e.g. `missing`, `value_error`. */
  readonly code: string;
  readonly message: string;
}

export type NerisFailureKind = 'validation' | 'rate_limited' | 'client_error' | 'server_error';

export interface NerisFailure {
  readonly ok: false;
  readonly kind: NerisFailureKind;
  readonly httpStatus: number;
  readonly issues: readonly NerisIssue[];
}

export type NerisResult<T> =
  ({ readonly ok: true; readonly httpStatus: number } & T) | NerisFailure;

export function failureKind(httpStatus: number): NerisFailureKind {
  if (httpStatus === 422) return 'validation';
  if (httpStatus === 429) return 'rate_limited';
  if (httpStatus >= 400 && httpStatus < 500) return 'client_error';
  return 'server_error';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const MAX_ISSUES = 50;
const MAX_MESSAGE_LENGTH = 500;

/** Flattens a 422 `HTTPValidationError {detail: [{loc, msg, type}]}` (or a plain detail string). */
export function parseNerisIssues(body: unknown): NerisIssue[] {
  const record = asRecord(body);
  const detail = record?.detail;
  if (typeof detail === 'string') {
    return [{ path: '', code: 'error', message: detail.slice(0, MAX_MESSAGE_LENGTH) }];
  }
  if (!Array.isArray(detail)) {
    return [];
  }
  return detail.slice(0, MAX_ISSUES).flatMap((entry) => {
    const item = asRecord(entry);
    if (!item) return [];
    const loc = Array.isArray(item.loc) ? item.loc : [];
    const path = loc
      .filter((part, index) => !(index === 0 && part === 'body'))
      .map((part) => (typeof part === 'number' ? `[${part}]` : String(part)))
      .join('.')
      .replace(/\.\[/g, '[');
    return [
      {
        path,
        code: typeof item.type === 'string' ? item.type : 'error',
        message: (typeof item.msg === 'string' ? item.msg : 'invalid value').slice(
          0,
          MAX_MESSAGE_LENGTH,
        ),
      },
    ];
  });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json();
    return body;
  } catch {
    return undefined;
  }
}

async function failure(response: Response): Promise<NerisFailure> {
  const body = response.status === 422 ? await readJson(response) : undefined;
  return {
    ok: false,
    kind: failureKind(response.status),
    httpStatus: response.status,
    issues: response.status === 422 ? parseNerisIssues(body) : [],
  };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function statusOf(value: unknown): NerisIncidentStatus | undefined {
  const status = asRecord(value)?.status;
  return isNerisIncidentStatus(status) ? status : undefined;
}

export interface NerisHistoryEntry {
  readonly status: NerisIncidentStatus;
  readonly current: boolean;
  readonly lastModified: string;
}

export interface NerisListedIncident {
  readonly nerisId: string;
  readonly incidentNumber?: string;
  readonly status?: NerisIncidentStatus;
  readonly lastModified?: string;
}

export interface NerisApi {
  createIncident(
    entity: string,
    payload: unknown,
  ): Promise<NerisResult<{ nerisId: string; status: NerisIncidentStatus | undefined }>>;
  validateIncident(entity: string, payload: unknown): Promise<NerisResult<object>>;
  replaceIncident(
    entity: string,
    nerisId: string,
    payload: unknown,
  ): Promise<NerisResult<{ lastModified: string | undefined }>>;
  getIncidentStatus(
    entity: string,
    nerisId: string,
  ): Promise<NerisResult<{ status: NerisIncidentStatus | undefined }>>;
  getIncidentHistory(
    department: string,
    nerisId: string,
  ): Promise<NerisResult<{ history: readonly NerisHistoryEntry[] }>>;
  listIncidents(
    entity: string,
    options?: { readonly maxPages?: number },
  ): Promise<NerisResult<{ incidents: readonly NerisListedIncident[]; truncated: boolean }>>;
  createNoActivityReport(
    entity: string,
    monthYear: string,
  ): Promise<NerisResult<{ nerisUid: string | undefined }>>;
  createStation(entity: string, payload: unknown): Promise<NerisResult<{ nerisId: string }>>;
  patchStation(entity: string, station: string, payload: unknown): Promise<NerisResult<object>>;
  createUnit(
    entity: string,
    station: string,
    payload: unknown,
  ): Promise<NerisResult<{ nerisId: string }>>;
  patchUnit(
    entity: string,
    station: string,
    unit: string,
    payload: unknown,
  ): Promise<NerisResult<object>>;
}

const DEFAULT_MAX_LIST_PAGES = 50;

export function createNerisApi(client: NerisClient): NerisApi {
  async function created(
    path: string,
    payload: unknown,
  ): Promise<NerisResult<{ nerisId: string }>> {
    const response = await client.fetch(path, jsonInit('POST', payload));
    if (!response.ok) return failure(response);
    const nerisId = asRecord(await readJson(response))?.neris_id;
    if (typeof nerisId !== 'string' || nerisId.length === 0) {
      return { ok: false, kind: 'server_error', httpStatus: response.status, issues: [] };
    }
    return { ok: true, httpStatus: response.status, nerisId };
  }

  async function modified(path: string, method: string, payload: unknown) {
    const response = await client.fetch(path, jsonInit(method, payload));
    if (!response.ok) return failure(response);
    return { ok: true as const, httpStatus: response.status };
  }

  return {
    async createIncident(entity, payload) {
      const response = await client.fetch(
        NERIS_PATHS.createIncident(entity),
        jsonInit('POST', payload),
      );
      if (!response.ok) return failure(response);
      const body = asRecord(await readJson(response));
      const nerisId = body?.neris_id;
      if (typeof nerisId !== 'string' || nerisId.length === 0) {
        // A 2xx with no id would leave the record unaddressable for every later update:
        // treat it as retryable rather than as a success we can never follow up on.
        return { ok: false, kind: 'server_error', httpStatus: response.status, issues: [] };
      }
      return {
        ok: true,
        httpStatus: response.status,
        nerisId,
        status: statusOf(body?.incident_status),
      };
    },

    async validateIncident(entity, payload) {
      const response = await client.fetch(
        NERIS_PATHS.validateIncident(entity),
        jsonInit('POST', payload),
      );
      if (!response.ok) return failure(response);
      return { ok: true, httpStatus: response.status };
    },

    async replaceIncident(entity, nerisId, payload) {
      const response = await client.fetch(
        NERIS_PATHS.incident(entity, nerisId),
        jsonInit('PUT', payload),
      );
      if (!response.ok) return failure(response);
      const lastModified = asRecord(await readJson(response))?.last_modified;
      return {
        ok: true,
        httpStatus: response.status,
        lastModified: typeof lastModified === 'string' ? lastModified : undefined,
      };
    },

    async getIncidentStatus(entity, nerisId) {
      const response = await client.fetch(NERIS_PATHS.incident(entity, nerisId), {
        method: 'GET',
      });
      if (!response.ok) return failure(response);
      const body = asRecord(await readJson(response));
      return { ok: true, httpStatus: response.status, status: statusOf(body?.incident_status) };
    },

    async getIncidentHistory(department, nerisId) {
      const response = await client.fetch(NERIS_PATHS.incidentHistory(department, nerisId), {
        method: 'GET',
      });
      if (!response.ok) return failure(response);
      const raw = asRecord(await readJson(response))?.history;
      const history = (Array.isArray(raw) ? raw : []).flatMap((entry) => {
        const item = asRecord(entry);
        if (!item || !isNerisIncidentStatus(item.status)) return [];
        return [
          {
            status: item.status,
            current: item.current === true,
            lastModified: typeof item.last_modified === 'string' ? item.last_modified : '',
          },
        ];
      });
      return { ok: true, httpStatus: response.status, history };
    },

    async listIncidents(entity, options = {}) {
      const maxPages = options.maxPages ?? DEFAULT_MAX_LIST_PAGES;
      const incidents: NerisListedIncident[] = [];
      let cursor: string | undefined;
      let pages = 0;
      let lastStatus: number;
      do {
        const query = new URLSearchParams({
          neris_id_entity: entity,
          page_size: String(NERIS_LIST_PAGE_SIZE),
          ...(cursor ? { cursor } : {}),
        });
        const response = await client.fetch(`${NERIS_PATHS.listIncidents()}?${query.toString()}`, {
          method: 'GET',
        });
        if (!response.ok) return failure(response);
        lastStatus = response.status;
        const body = asRecord(await readJson(response));
        for (const entry of Array.isArray(body?.incidents) ? body.incidents : []) {
          const item = asRecord(entry);
          if (!item || typeof item.neris_id !== 'string') continue;
          const incidentNumber = asRecord(item.base)?.incident_number;
          const status = statusOf(item.incident_status);
          incidents.push({
            nerisId: item.neris_id,
            ...(typeof incidentNumber === 'string' ? { incidentNumber } : {}),
            ...(status ? { status } : {}),
            ...(typeof item.last_modified === 'string' ? { lastModified: item.last_modified } : {}),
          });
        }
        cursor = typeof body?.next_cursor === 'string' ? body.next_cursor : undefined;
        pages += 1;
      } while (cursor && pages < maxPages);
      return { ok: true, httpStatus: lastStatus, incidents, truncated: cursor !== undefined };
    },

    async createNoActivityReport(entity, monthYear) {
      const response = await client.fetch(
        NERIS_PATHS.createNoActivityReport(entity),
        jsonInit('POST', { month_year: monthYear }),
      );
      if (!response.ok) return failure(response);
      const uid = asRecord(await readJson(response))?.neris_uid;
      return {
        ok: true,
        httpStatus: response.status,
        nerisUid: typeof uid === 'string' ? uid : undefined,
      };
    },

    createStation: (entity, payload) => created(NERIS_PATHS.createStation(entity), payload),
    patchStation: (entity, station, payload) =>
      modified(NERIS_PATHS.station(entity, station), 'PATCH', payload),
    createUnit: (entity, station, payload) =>
      created(NERIS_PATHS.createUnit(entity, station), payload),
    patchUnit: (entity, station, unit, payload) =>
      modified(NERIS_PATHS.unit(entity, station, unit), 'PATCH', payload),
  };
}
