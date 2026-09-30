export type IncidentStatus = 'DRAFT' | 'VALIDATED' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED';

export interface Incident {
  incidentId: string;
  deptId: string;
  dispatchNumber: string;
  epochSeconds: number;
  nerisSchemaVersion: string;
  corePayload: Record<string, unknown>;
  incidentType?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  alarmAt?: number;
  dispatchAt?: number;
  arrivedAt?: number;
  clearedAt?: number;
  narrative?: string;
  status: IncidentStatus;
  sourceDispatchId: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Epoch seconds the officer review locked the report; every edit route answers 409 while set. */
  lockedAt?: number | null;
  lockedBy?: string | null;
  submissionStatus?: SubmissionStatus | null;
  nerisIncidentId?: string | null;
  nerisStatus?: NerisStatus | null;
  nerisStatusAt?: number | null;
  firstSubmittedAt?: number | null;
  lastPayloadHash?: string | null;
}

/** incident-service submissionRepository.ts SUBMISSION_STATUSES (F7.7). */
export type SubmissionStatus = 'SUBMITTED' | 'ACCEPTED' | 'FAILED' | 'RETRYING';

/** NERIS's own lifecycle status for a submitted incident (synced by the status poller). */
export const NERIS_STATUSES = [
  'SUBMITTED',
  'PENDING_INCIDENT_DATA',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'FAILED',
  'DELETED',
] as const;
export type NerisStatus = (typeof NERIS_STATUSES)[number];

export type AttemptOutcome =
  | 'SUCCESS'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'SERVER_ERROR'
  | 'CLIENT_ERROR'
  | 'NOT_CONFIGURED';

export interface SubmissionAttemptError {
  path: string;
  code: string;
  message: string;
}

export interface SubmissionAttempt {
  attempt: number;
  /** ISO timestamp. */
  attemptedAt: string;
  outcome: AttemptOutcome;
  httpStatus: number | null;
  retryCount: number;
  operation?: 'CREATE' | 'UPDATE';
  nerisIncidentId?: string;
  nerisStatus?: string;
  payloadHash?: string;
  failureReason?: string;
  errors: SubmissionAttemptError[];
}

export interface SubmissionStatusEntry {
  status: string;
  /** ISO timestamp. */
  at: string;
  current: boolean;
}

/** GET /incidents/{id}/submissions — the NERIS submission ledger, never silently dropped. */
export interface SubmissionState {
  incidentId: string;
  status: IncidentStatus;
  submissionStatus: SubmissionStatus | null;
  submissionFailureReason?: string;
  nerisIncidentId?: string | null;
  nerisStatus?: string | null;
  nerisStatusAt?: number | null;
  lockedAt?: number | null;
  lockedBy?: string | null;
  payloadHash?: string | null;
  firstSubmittedAt?: number | null;
  editedSinceSubmission?: boolean;
  attempts?: SubmissionAttempt[];
  statusHistory?: SubmissionStatusEntry[];
}

export type ValidationMode = 'local' | 'neris' | 'both';

export const VALIDATION_SECTIONS = [
  'core',
  'dispatch',
  'units',
  'narrative',
  'fire',
  'neris',
] as const;
export type ValidationSection = (typeof VALIDATION_SECTIONS)[number];

/** A one-tap fix the server proposes; `path` uses the same grammar as the issue path. */
export interface ValidationFix {
  label: string;
  path: string;
  value: string | number;
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
  section: ValidationSection;
  fix?: ValidationFix;
}

/** 200 body of POST /incidents/{id}/validate. */
export interface ValidationReport {
  incidentId: string;
  mode: ValidationMode;
  blocking: ValidationIssue[];
  warnings: ValidationIssue[];
  /** ISO timestamp of the last NERIS-side validation, or null when NERIS was not asked. */
  nerisValidatedAt: string | null;
  sectionsComplete: Partial<Record<ValidationSection, boolean>>;
}

/** 200 body of POST /incidents/{id}/lock. */
export interface LockResponse {
  incidentId: string;
  lockedAt: number;
  lockedBy: string;
  status: IncidentStatus;
  submission: { status: 'QUEUED' } | null;
  nerisValidatedAt: string | null;
  warnings: ValidationIssue[];
}

/** 200 body of POST /incidents/{id}/unlock. */
export interface UnlockResponse {
  incidentId: string;
  unlockedAt: number;
  unlockedBy: string;
  reason: string;
}

export interface ResubmitDiffEntry {
  path: string;
  before?: unknown;
  after?: unknown;
}

/** 202 (queued) or 200 (UNCHANGED) body of POST /incidents/{id}/resubmit. */
export interface ResubmitResponse {
  incidentId: string;
  nerisIncidentId?: string;
  diff: ResubmitDiffEntry[];
  status: 'QUEUED' | 'UNCHANGED';
  submissionStatus?: SubmissionStatus;
}

export const MIN_UNLOCK_REASON_LENGTH = 5;
export const MAX_UNLOCK_REASON_LENGTH = 1000;

/** 202 body of POST .../submit and POST .../submission/retry. */
export interface SubmissionAccepted {
  incidentId: string;
  submissionStatus: SubmissionStatus;
}

export type ResponseUnitType = 'APPARATUS' | 'MEMBER';

export interface ResponseUnit {
  incidentId: string;
  unitId: string;
  unitType: ResponseUnitType;
  dispatchedAt?: number;
  enRouteAt?: number;
  arrivedAt?: number;
  clearedAt?: number;
  assignedPositions?: string[];
}

export interface RespondingMember {
  memberId: string;
  status?: string;
}

export interface IncidentSecondary {
  incidentId: string;
  secondaryType: string;
  payload: Record<string, string>;
  affectedMemberIds: string[];
  complete?: boolean;
  updatedAt: number;
}

/** GET adds modules the caller is allowed to see. Units ride along when the API includes them. */
export interface IncidentDetail extends Incident {
  secondaryModules?: IncidentSecondary[];
  respondingUnits?: ResponseUnit[];
  respondingMembers?: RespondingMember[];
}

export interface CreateIncidentInput {
  dispatchId: string;
}

export type GetIncidentResponse = IncidentDetail;
export type CreateIncidentResponse = IncidentDetail;

export interface SearchIncidentsParams {
  fromAlarmAt: number;
  toAlarmAt: number;
}

export interface UpdateIncidentInput {
  fields: Record<string, string>;
}

export interface PutExposureInput {
  secondaryType: string;
  payload: Record<string, string>;
  affectedMemberIds: string[];
}

export interface PutExposureResponse {
  incidentId: string;
  secondaryType: string;
  payload: Record<string, string>;
  affectedMemberIds: string[];
  complete: boolean;
  updatedAt: number;
}

export const MAX_NARRATIVE_LENGTH = 25_000;

export const TIME_FIELDS = ['dispatchedAt', 'enRouteAt', 'arrivedAt', 'clearedAt'] as const;
export type TimeField = (typeof TIME_FIELDS)[number];

/** One NERIS TypeIncidentValue (`FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE`) and its readable label. */
export interface NerisIncidentType {
  value: string;
  label: string;
}

/** A NERIS module sub-schema in the incident service's compiled grammar: `node` plus its `defs`. */
export interface NerisModuleSchema {
  node: unknown;
  defs: Record<string, unknown>;
}

/** 200 body of GET /incidents/neris-schema (503 NERIS_SCHEMA_UNAVAILABLE until downloaded). */
export interface NerisSchemaResponse {
  version: string;
  apiVersion: string;
  incidentTypes: NerisIncidentType[];
  modules: Partial<Record<string, NerisModuleSchema>>;
}

/** GET /incidents/dispatches: a dispatch to start a report from (incident-service's copy). */
export interface RecentDispatch {
  dispatchId: string;
  incidentType: string;
  address: string;
  /** Epoch seconds. */
  dispatchedAt: number;
  /** The report already started from this dispatch, if any. */
  report: { incidentId: string; status: IncidentStatus } | null;
  /** A CAD dispatch that couldn't be parsed: its address is a placeholder. */
  verifyRequired?: true;
  /** The start of its dispatch text, sent with verifyRequired. */
  textExcerpt?: string;
}

export interface RecentDispatchPage {
  /** The first page is every dispatch of this many hours. */
  recentWindowHours: number;
  dispatches: RecentDispatch[];
  /** Pass back to read older dispatches; null when there are none. */
  nextCursor: string | null;
}
