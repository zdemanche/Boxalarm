import {
  ApiError,
  apiRequest,
  type AuthTokenSource,
  type ProblemDetails,
} from '../../lib/apiClient';
import type { FieldError } from './validateEnum';
import type {
  CreateIncidentInput,
  CreateIncidentResponse,
  GetIncidentResponse,
  Incident,
  LockResponse,
  PutExposureInput,
  PutExposureResponse,
  ResponseUnit,
  ResubmitResponse,
  SearchIncidentsParams,
  SubmissionAccepted,
  SubmissionState,
  TimeField,
  UnlockResponse,
  UpdateIncidentInput,
  ValidationIssue,
  ValidationMode,
  ValidationReport,
  ValidationSection,
} from './types';

function incidentPath(incidentId: string): string {
  return `incidents/${encodeURIComponent(incidentId)}`;
}

export async function searchIncidents(
  tokens: AuthTokenSource,
  params: SearchIncidentsParams,
): Promise<Incident[]> {
  const qs = new URLSearchParams({
    fromAlarmAt: String(params.fromAlarmAt),
    toAlarmAt: String(params.toAlarmAt),
  });
  const response = await apiRequest(`incidents?${qs.toString()}`, tokens);
  const body = (await response.json()) as { incidents: Incident[] };
  return body.incidents;
}

export async function getIncident(
  tokens: AuthTokenSource,
  incidentId: string,
): Promise<GetIncidentResponse> {
  const response = await apiRequest(incidentPath(incidentId), tokens);
  return (await response.json()) as GetIncidentResponse;
}

export async function createIncidentFromDispatch(
  tokens: AuthTokenSource,
  input: CreateIncidentInput,
): Promise<CreateIncidentResponse> {
  const response = await apiRequest('incidents', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as CreateIncidentResponse;
}

export async function updateIncident(
  tokens: AuthTokenSource,
  incidentId: string,
  input: UpdateIncidentInput,
): Promise<GetIncidentResponse> {
  const response = await apiRequest(incidentPath(incidentId), tokens, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as GetIncidentResponse;
}

export async function putNarrative(
  tokens: AuthTokenSource,
  incidentId: string,
  narrative: string,
): Promise<GetIncidentResponse> {
  const response = await apiRequest(`${incidentPath(incidentId)}/narrative`, tokens, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ narrative }),
  });
  return (await response.json()) as GetIncidentResponse;
}

export async function putResponseTimes(
  tokens: AuthTokenSource,
  incidentId: string,
  input: {
    unitId: string;
    unitType: ResponseUnit['unitType'];
  } & Partial<Record<TimeField, number>>,
): Promise<ResponseUnit> {
  const response = await apiRequest(`${incidentPath(incidentId)}/response-times`, tokens, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as ResponseUnit;
}

export async function putExposure(
  tokens: AuthTokenSource,
  incidentId: string,
  input: PutExposureInput,
): Promise<PutExposureResponse> {
  const response = await apiRequest(`${incidentPath(incidentId)}/exposures`, tokens, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as PutExposureResponse;
}

/** F7.6: accept-and-queue — 202 once the incident is SUBMITTED and the worker is enqueued. */
export async function submitIncident(
  tokens: AuthTokenSource,
  incidentId: string,
): Promise<SubmissionAccepted> {
  const response = await apiRequest(`${incidentPath(incidentId)}/submit`, tokens, {
    method: 'POST',
  });
  return (await response.json()) as SubmissionAccepted;
}

export async function getSubmission(
  tokens: AuthTokenSource,
  incidentId: string,
): Promise<SubmissionState> {
  const response = await apiRequest(`${incidentPath(incidentId)}/submissions`, tokens);
  return (await response.json()) as SubmissionState;
}

/** Runs the review checklist. Any role; `neris`/`both` also ask NERIS's own validator. */
export async function validateIncident(
  tokens: AuthTokenSource,
  incidentId: string,
  mode: ValidationMode,
): Promise<ValidationReport> {
  const response = await apiRequest(`${incidentPath(incidentId)}/validate`, tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  return (await response.json()) as ValidationReport;
}

/** Officer sign-off. 409 VALIDATION_BLOCKED carries the blocking list as problem extensions. */
export async function lockIncident(
  tokens: AuthTokenSource,
  incidentId: string,
): Promise<LockResponse> {
  const response = await apiRequest(`${incidentPath(incidentId)}/lock`, tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attest: true }),
  });
  return (await response.json()) as LockResponse;
}

/** Chief/admin only; `reason` is 5-1000 characters and lands in the audit trail. */
export async function unlockIncident(
  tokens: AuthTokenSource,
  incidentId: string,
  reason: string,
): Promise<UnlockResponse> {
  const response = await apiRequest(`${incidentPath(incidentId)}/unlock`, tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  return (await response.json()) as UnlockResponse;
}

/** Sends the changes since the last NERIS submission; 200 UNCHANGED when there are none. */
export async function resubmitIncident(
  tokens: AuthTokenSource,
  incidentId: string,
): Promise<ResubmitResponse> {
  const response = await apiRequest(`${incidentPath(incidentId)}/resubmit`, tokens, {
    method: 'POST',
  });
  return (await response.json()) as ResubmitResponse;
}

/** The machine-readable `code` extension of an RFC 7807 problem, when there is one. */
export function problemCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const code = (error.problem as ProblemDetails & { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

const SECTIONS: readonly string[] = ['core', 'dispatch', 'units', 'narrative', 'fire', 'neris'];

function issuesFrom(value: unknown): ValidationIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.path !== 'string' ||
      typeof record.code !== 'string' ||
      typeof record.message !== 'string'
    ) {
      return [];
    }
    const section = (
      typeof record.section === 'string' && SECTIONS.includes(record.section)
        ? record.section
        : 'core'
    ) as ValidationSection;
    const fix = record.fix as Record<string, unknown> | undefined;
    const validFix =
      fix &&
      typeof fix.label === 'string' &&
      typeof fix.path === 'string' &&
      (typeof fix.value === 'string' || typeof fix.value === 'number')
        ? { label: fix.label, path: fix.path, value: fix.value }
        : undefined;
    return [
      {
        path: record.path,
        code: record.code,
        message: record.message,
        section,
        ...(validFix ? { fix: validFix } : {}),
      },
    ];
  });
}

/** The blocking/warning lists a 409 VALIDATION_BLOCKED lock refusal carries (untrusted JSON). */
export function lockRefusalFrom(
  error: unknown,
): Pick<ValidationReport, 'blocking' | 'warnings' | 'sectionsComplete'> | undefined {
  if (problemCode(error) !== 'VALIDATION_BLOCKED' || !(error instanceof ApiError)) return undefined;
  const extra = error.problem as ProblemDetails & {
    blocking?: unknown;
    warnings?: unknown;
    sectionsComplete?: unknown;
  };
  const sections =
    typeof extra.sectionsComplete === 'object' && extra.sectionsComplete !== null
      ? (extra.sectionsComplete as ValidationReport['sectionsComplete'])
      : {};
  return {
    blocking: issuesFrom(extra.blocking),
    warnings: issuesFrom(extra.warnings),
    sectionsComplete: sections,
  };
}

/** Re-queues a FAILED submission (409 for any other submission status). */
export async function retrySubmission(
  tokens: AuthTokenSource,
  incidentId: string,
): Promise<SubmissionAccepted> {
  const response = await apiRequest(`${incidentPath(incidentId)}/submission/retry`, tokens, {
    method: 'POST',
  });
  return (await response.json()) as SubmissionAccepted;
}

export function fieldErrorsFromUnknown(error: unknown): FieldError[] {
  if (!(error instanceof ApiError)) return [];
  const extra = error.problem as ProblemDetails & { errors?: unknown };
  if (!Array.isArray(extra.errors)) return [];
  return extra.errors.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as { field?: unknown; message?: unknown };
    if (typeof record.field !== 'string' || typeof record.message !== 'string') return [];
    return [{ field: record.field, message: record.message }];
  });
}
