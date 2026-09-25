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
}

export interface CreateIncidentInput {
  dispatchId: string;
}

export type GetIncidentResponse = Incident;
export type CreateIncidentResponse = Incident;

export interface SearchIncidentsParams {
  fromAlarmAt: number;
  toAlarmAt: number;
}
