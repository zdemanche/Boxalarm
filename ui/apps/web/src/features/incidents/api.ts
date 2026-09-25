import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import type {
  CreateIncidentInput,
  CreateIncidentResponse,
  GetIncidentResponse,
  Incident,
  SearchIncidentsParams,
} from './types';

function incident(incidentId: string): string {
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
  const response = await apiRequest(incident(incidentId), tokens);
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
