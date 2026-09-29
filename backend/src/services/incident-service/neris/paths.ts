/**
 * Every NERIS API path this service calls, in one place.
 *
 * Verified 2026-09-29 against the live OpenAPI documents, which list identical paths:
 *   - production  https://api.neris.fsri.org/openapi.json       (NERIS v1.4.78)
 *   - test        https://api-test.neris.fsri.org/openapi.json  (NERIS v1.5.1)
 * and against FSRI's reference client (github.com/ulfsri/neris-api-client, client.py).
 *
 * Both documents declare their server as `https://<host>/v1`, so the configured base URL
 * must end in `/v1` (infrastructure/components/neris/neris-config.ts): `<host>/health`
 * is a 404 while `<host>/v1/health` is a 200. Paths below are relative to that base.
 *
 * Auth: `POST /token` (form-encoded `grant_type=client_credentials`, HTTP Basic
 * client_id:client_secret) returns `{access_token, expires_in}`; every other call sends
 * `Authorization: Bearer <token>` and a `User-Agent` (the WAF returns 403 without one).
 * See tokenCache.ts and client.ts.
 *
 * `entity` is the department's NERIS id (`FD` + 8 digits). A NERIS incident id has the
 * shape `FD12345678|<incident number>|<epoch seconds>`; the `|` must be percent-encoded
 * in a path segment, so every builder encodes its arguments.
 */

const seg = (value: string): string => encodeURIComponent(value);

export const NERIS_PATHS = {
  /** 201 `IncidentCreatedResponse {neris_id, incident_status}` or 422. */
  createIncident: (entity: string): string => `/incident/${seg(entity)}`,
  /** 204 (valid, nothing stored) or 422 `HTTPValidationError`. */
  validateIncident: (entity: string): string => `/incident/${seg(entity)}/validate`,
  /** GET `IncidentResponse` / PUT (full replace, `PutIncidentPayload`) -> `{last_modified}`. */
  incident: (entity: string, nerisIncidentId: string): string =>
    `/incident/${seg(entity)}/${seg(nerisIncidentId)}`,
  /** `IncidentHistoryResponse {history: [{status, current, last_modified, ...}]}`. */
  incidentHistory: (department: string, nerisIncidentId: string): string =>
    `/incident/${seg(department)}/${seg(nerisIncidentId)}/history`,
  /** `ListIncidentsResponse {incidents, next_cursor, prev_cursor}`; query `neris_id_entity`, `cursor`, `page_size` (max 100). */
  listIncidents: (): string => '/incident',
  /** Body `{month_year: "MM/YYYY"}` -> 201 `NoActivityReportResponse`. */
  createNoActivityReport: (entity: string): string => `/no_activity_report/${seg(entity)}`,
  /** Body `CreateStationPayload` -> 201 `StationCreatedModifiedResponse {neris_id, units}`. */
  createStation: (entity: string): string => `/entity/${seg(entity)}/station`,
  /** Body `PatchStationPayload` -> 200. */
  station: (entity: string, station: string): string =>
    `/entity/${seg(entity)}/station/${seg(station)}`,
  /** Body `CreateUnitPayload` -> 201 `UnitCreatedModifiedResponse {neris_id}`. */
  createUnit: (entity: string, station: string): string =>
    `/entity/${seg(entity)}/station/${seg(station)}/unit`,
  /** Body `PatchUnitPayload` -> 200. */
  unit: (entity: string, station: string, unit: string): string =>
    `/entity/${seg(entity)}/station/${seg(station)}/unit/${seg(unit)}`,
} as const;

/** `TypeIncidentStatusValue` (both spec versions). */
export const NERIS_INCIDENT_STATUSES = [
  'SUBMITTED',
  'PENDING_INCIDENT_DATA',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'FAILED',
  'DELETED',
] as const;

export type NerisIncidentStatus = (typeof NERIS_INCIDENT_STATUSES)[number];

export function isNerisIncidentStatus(value: unknown): value is NerisIncidentStatus {
  return (
    typeof value === 'string' && (NERIS_INCIDENT_STATUSES as readonly string[]).includes(value)
  );
}

/** Statuses the status poller keeps watching; every other status is final. */
export const OPEN_NERIS_STATUSES: ReadonlySet<NerisIncidentStatus> = new Set([
  'SUBMITTED',
  'PENDING_INCIDENT_DATA',
  'PENDING_APPROVAL',
]);

export const NERIS_DEPARTMENT_ID_PATTERN = /^FD\d{8}$/;
export const NERIS_INCIDENT_NUMBER_PATTERN = /^[\w\-:]+$/;
/** `GET /incident` page_size maximum. */
export const NERIS_LIST_PAGE_SIZE = 100;
