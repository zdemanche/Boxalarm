import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import type {
  AuditPage,
  ConfigResponse,
  DisposalResult,
  EditableConfigType,
  ExportStatus,
  RetentionConfig,
} from './types';

export async function getConfig(
  tokens: AuthTokenSource,
  configType: EditableConfigType,
): Promise<ConfigResponse> {
  const response = await apiRequest(`platform/config/${configType}`, tokens);
  return (await response.json()) as ConfigResponse;
}

export async function putConfig(
  tokens: AuthTokenSource,
  configType: EditableConfigType,
  value: Record<string, unknown>,
  expectedVersion: number | undefined,
): Promise<ConfigResponse> {
  const response = await apiRequest(`platform/config/${configType}`, tokens, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      value,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    }),
  });
  return (await response.json()) as ConfigResponse;
}

export async function getAuditTrail(
  tokens: AuthTokenSource,
  entityType: string,
  entityId: string,
  cursor?: string,
): Promise<AuditPage> {
  const params = new URLSearchParams({ entityType, entityId, ...(cursor ? { cursor } : {}) });
  const response = await apiRequest(`platform/audit?${params.toString()}`, tokens);
  return (await response.json()) as AuditPage;
}

export async function startExport(tokens: AuthTokenSource): Promise<{ jobId: string }> {
  const response = await apiRequest('platform/export', tokens, { method: 'POST' });
  return (await response.json()) as { jobId: string };
}

export async function getExportStatus(
  tokens: AuthTokenSource,
  jobId: string,
): Promise<ExportStatus> {
  const response = await apiRequest(`platform/export/${encodeURIComponent(jobId)}`, tokens);
  return (await response.json()) as ExportStatus;
}

export async function getRetentionConfig(tokens: AuthTokenSource): Promise<RetentionConfig> {
  const response = await apiRequest('platform/retention', tokens);
  return (await response.json()) as RetentionConfig;
}

export async function putRetentionConfig(
  tokens: AuthTokenSource,
  retentionYears: number,
): Promise<void> {
  await apiRequest('platform/retention', tokens, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ retentionYears }),
  });
}

export async function runDisposal(tokens: AuthTokenSource): Promise<DisposalResult> {
  const response = await apiRequest('platform/retention/disposal', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return (await response.json()) as DisposalResult;
}

export async function revokeMemberSessions(
  tokens: AuthTokenSource,
  memberId: string,
): Promise<{ memberId: string; status: string }> {
  const response = await apiRequest('platform/sessions/revoke', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId }),
  });
  return (await response.json()) as { memberId: string; status: string };
}
