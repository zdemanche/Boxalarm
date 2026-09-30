import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import type {
  AuditPage,
  CadParserFields,
  CadSourceInput,
  CadSourcesResponse,
  CadTestParseResult,
  RotatedWebhookKey,
  ConfigResponse,
  DisposalResult,
  EditableConfigType,
  ExportStatus,
  MemberDevices,
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

/**
 * A member's registered push devices (CHIEF/ADMIN, Cedar ViewMemberDevices), newest
 * registration first, so a device-loss report can remove just the lost one.
 */
export async function listMemberDevices(
  tokens: AuthTokenSource,
  memberId: string,
): Promise<MemberDevices> {
  const response = await apiRequest(
    `platform/sessions/${encodeURIComponent(memberId)}/devices`,
    tokens,
  );
  return (await response.json()) as MemberDevices;
}

/**
 * Report a member's device lost (CHIEF/ADMIN, Cedar RevokeSession): every session is signed
 * out and already-issued tokens stop within about 30 s. Push is removed from `deviceId` only,
 * or from every device when it is omitted, so the lost phone stops showing dispatches.
 */
export async function revokeMemberSessions(
  tokens: AuthTokenSource,
  memberId: string,
  deviceId?: string,
): Promise<{ memberId: string; status: string; push?: string; deviceId?: string }> {
  const response = await apiRequest('platform/sessions/revoke', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(deviceId === undefined ? { memberId } : { memberId, deviceId }),
  });
  return (await response.json()) as {
    memberId: string;
    status: string;
    push?: string;
    deviceId?: string;
  };
}

/**
 * The compromised-password kill switch (CHIEF/ADMIN, Cedar ResetMemberCredentials): the
 * current password stops working and every session is signed out. The member sets a new
 * password through the self-service "forgot password" flow.
 */
export async function resetMemberCredentials(
  tokens: AuthTokenSource,
  memberId: string,
): Promise<{ memberId: string; status: string }> {
  const response = await apiRequest('platform/sessions/reset-credentials', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId }),
  });
  return (await response.json()) as { memberId: string; status: string };
}

/** The department's CAD ingress sources (CHIEF/ADMIN, Cedar ViewCadIngress). */
export async function getCadSources(tokens: AuthTokenSource): Promise<CadSourcesResponse> {
  const response = await apiRequest('platform/cad-sources', tokens);
  return (await response.json()) as CadSourcesResponse;
}

/** Save every source (Cedar ManageCadIngress). `expectedVersion` is the version last loaded. */
export async function putCadSources(
  tokens: AuthTokenSource,
  sources: CadSourceInput[],
  expectedVersion: number | null,
): Promise<CadSourcesResponse> {
  const response = await apiRequest('platform/cad-sources', tokens, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sources,
      ...(expectedVersion !== null ? { expectedVersion } : {}),
    }),
  });
  return (await response.json()) as CadSourcesResponse;
}

/** Run a draft parser template over a pasted sample - the same parser real dispatches use. */
export async function testParseCad(
  tokens: AuthTokenSource,
  fields: CadParserFields,
  sample: string,
): Promise<CadTestParseResult> {
  const response = await apiRequest('platform/cad-sources/test-parse', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, sample }),
  });
  return (await response.json()) as CadTestParseResult;
}

/** Mint a new webhook key for a saved source. The key is in this response only. */
export async function rotateCadWebhookKey(
  tokens: AuthTokenSource,
  sourceId: string,
): Promise<RotatedWebhookKey> {
  const response = await apiRequest(
    `platform/cad-sources/${encodeURIComponent(sourceId)}/webhook-key`,
    tokens,
    { method: 'POST' },
  );
  return (await response.json()) as RotatedWebhookKey;
}
