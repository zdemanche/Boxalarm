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
}

export interface CreateIncidentInput {
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
