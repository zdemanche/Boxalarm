export type AssignedToType = 'MEMBER' | 'APPARATUS';
export type LifecycleStatus = 'ACQUIRED' | 'IN_SERVICE' | 'RETIRED';

export interface EquipmentAsset {
  assetId: string;
  deptId: string;
  serialNumber: string;
  assignedToType?: AssignedToType;
  assignedToId?: string;
  location: string;
  lifecycleStatus: LifecycleStatus;
}

export interface CreateEquipmentAssetInput {
  serialNumber: string;
  location: string;
}

export interface ConsumableStock {
  itemId: string;
  deptId: string;
  itemName: string;
  stockLevel: number;
  reorderThreshold: number;
  location?: string;
  reorderFlagged: boolean;
}

export type PpeStatus = 'ISSUED' | 'RETIRED' | 'EXPIRED';

export interface PpeAssignment {
  ppeItemId: string;
  memberId: string;
  itemType: string;
  size: string;
  issueDate: string;
  nfpaExpiryDate: string;
  status: PpeStatus;
}

export interface IssuePpeInput {
  itemType: string;
  size: string;
  issueDate: string;
}
