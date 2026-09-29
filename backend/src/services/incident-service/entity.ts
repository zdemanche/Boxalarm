/**
 * NERIS-native INCIDENT entity types.
 * Opaque versioned corePayload — never explode NERIS fields into Dynamo attributes.
 */

export const INCIDENT_STATUSES = [
  'DRAFT',
  'VALIDATED',
  'SUBMITTED',
  'ACCEPTED',
  'REJECTED',
] as const;

export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export function isIncidentStatus(value: unknown): value is IncidentStatus {
  return typeof value === 'string' && (INCIDENT_STATUSES as readonly string[]).includes(value);
}

/** NERIS ID composition: `{deptId}-{dispatchNumber}-{epochSeconds}` — same as dispatchId. */
export function buildNerisIncidentId(
  deptId: string,
  dispatchNumber: string,
  epochSeconds: number,
): string {
  return `${deptId}-${dispatchNumber}-${epochSeconds}`;
}

export interface Incident {
  readonly incidentId: string;
  readonly deptId: string;
  readonly dispatchNumber: string;
  readonly epochSeconds: number;
  readonly nerisSchemaVersion: string;
  readonly corePayload: Readonly<Record<string, unknown>>;
  readonly incidentType?: string;
  readonly address?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly alarmAt?: number;
  readonly dispatchAt?: number;
  readonly arrivedAt?: number;
  readonly clearedAt?: number;
  readonly narrative?: string;
  readonly status: IncidentStatus;
  readonly sourceDispatchId: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Officer review lock (epoch seconds); every edit route returns 409 while it is set. */
  readonly lockedAt?: number;
  readonly lockedBy?: string;
  /** Submission pipeline state (submissionRepository.ts SUBMISSION_STATUSES). */
  readonly submissionStatus?: string;
  /** NERIS's id for the record (`FD…|number|epoch`), set by the first accepted create. */
  readonly nerisIncidentId?: string;
  /** NERIS's own lifecycle status (`TypeIncidentStatusValue`), synced by the status poller. */
  readonly nerisStatus?: string;
  readonly nerisStatusAt?: number;
  /** Epoch seconds NERIS first accepted the record (drives the 72-hour compliance tile). */
  readonly firstSubmittedAt?: number;
  /** The NERIS id a create in progress will produce (set before the POST; review M2). */
  readonly pendingNerisId?: string;
  /** sha256 of the last payload NERIS accepted; a differing hash means edits await resubmission. */
  readonly lastPayloadHash?: string;
}

export interface CreateIncidentInput {
  /** Overrides the composed `{deptId}-{dispatchNumber}-{epochSeconds}` id (E6-S2 dispatch-linked creation). */
  readonly incidentId?: string;
  readonly dispatchNumber: string;
  readonly epochSeconds: number;
  readonly nerisSchemaVersion: string;
  readonly corePayload: Readonly<Record<string, unknown>>;
  readonly status?: IncidentStatus;
  readonly incidentType?: string;
  readonly address?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly alarmAt?: number;
  readonly dispatchAt?: number;
  readonly arrivedAt?: number;
  readonly clearedAt?: number;
  readonly narrative?: string;
  readonly createdBy: string;
}
