import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import type {
  AssignedToType,
  ConsumableStock,
  CreateEquipmentAssetInput,
  EquipmentAsset,
  IssuePpeInput,
  LifecycleStatus,
  PpeAssignment,
} from './types';

export async function listEquipment(
  tokens: AuthTokenSource,
  filter?: { assignedToType?: AssignedToType; assignedToId?: string },
): Promise<EquipmentAsset[]> {
  const params = new URLSearchParams();
  if (filter?.assignedToType) params.set('assignedToType', filter.assignedToType);
  if (filter?.assignedToId) params.set('assignedToId', filter.assignedToId);
  const qs = params.toString();
  const response = await apiRequest(`inventory/equipment${qs ? `?${qs}` : ''}`, tokens);
  const body = (await response.json()) as { items: EquipmentAsset[] };
  return body.items;
}

export async function getEquipmentAsset(
  tokens: AuthTokenSource,
  assetId: string,
): Promise<EquipmentAsset> {
  const response = await apiRequest(`inventory/equipment/${encodeURIComponent(assetId)}`, tokens);
  return (await response.json()) as EquipmentAsset;
}

export async function createEquipmentAsset(
  tokens: AuthTokenSource,
  input: CreateEquipmentAssetInput,
): Promise<EquipmentAsset> {
  const response = await apiRequest('inventory/equipment', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as EquipmentAsset;
}

export async function assignEquipmentAsset(
  tokens: AuthTokenSource,
  assetId: string,
  assignedToType: AssignedToType,
  assignedToId: string,
): Promise<EquipmentAsset> {
  const response = await apiRequest(
    `inventory/equipment/${encodeURIComponent(assetId)}/assignment`,
    tokens,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedToType, assignedToId }),
    },
  );
  return (await response.json()) as EquipmentAsset;
}

export async function setEquipmentLocation(
  tokens: AuthTokenSource,
  assetId: string,
  location: string,
): Promise<EquipmentAsset> {
  const response = await apiRequest(
    `inventory/equipment/${encodeURIComponent(assetId)}/location`,
    tokens,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location }),
    },
  );
  return (await response.json()) as EquipmentAsset;
}

export async function transitionEquipmentLifecycle(
  tokens: AuthTokenSource,
  assetId: string,
  lifecycleStatus: LifecycleStatus,
): Promise<Pick<EquipmentAsset, 'assetId' | 'lifecycleStatus'>> {
  const response = await apiRequest(
    `inventory/equipment/${encodeURIComponent(assetId)}/lifecycle`,
    tokens,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lifecycleStatus }),
    },
  );
  return (await response.json()) as Pick<EquipmentAsset, 'assetId' | 'lifecycleStatus'>;
}

export async function listConsumables(tokens: AuthTokenSource): Promise<ConsumableStock[]> {
  const response = await apiRequest('inventory/consumables', tokens);
  const body = (await response.json()) as { items: ConsumableStock[] };
  return body.items;
}

export async function listMemberPpe(
  tokens: AuthTokenSource,
  memberId: string,
): Promise<PpeAssignment[]> {
  const response = await apiRequest(`inventory/ppe/${encodeURIComponent(memberId)}`, tokens);
  return (await response.json()) as PpeAssignment[];
}

export async function issueMemberPpe(
  tokens: AuthTokenSource,
  memberId: string,
  input: IssuePpeInput,
): Promise<PpeAssignment> {
  const response = await apiRequest(`inventory/ppe/${encodeURIComponent(memberId)}`, tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as PpeAssignment;
}
