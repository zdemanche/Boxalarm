// Shaped to match inventory-service's EQUIPMENT_ASSET and PPE_ASSIGNMENT (Data Model §3.3).

export type AssignedToType = 'MEMBER' | 'APPARATUS';
export type LifecycleStatus = 'ACQUIRED' | 'IN_SERVICE' | 'RETIRED';

export interface EquipmentAsset {
  assetId: string;
  serialNumber: string;
  assignedToType?: AssignedToType;
  assignedToId?: string;
  location: string;
  lifecycleStatus: LifecycleStatus;
}

export type PpeStatus = 'ISSUED' | 'RETIRED' | 'EXPIRED';

export interface PpeAssignment {
  ppeItemId: string;
  itemType: string;
  size: string;
  issueDate: string;
  nfpaExpiryDate: string;
  status: PpeStatus;
}

export interface InventoryRepository {
  getMyEquipment(memberId: string): Promise<EquipmentAsset[]>;
  getMyPpe(memberId: string): Promise<PpeAssignment[]>;
}
