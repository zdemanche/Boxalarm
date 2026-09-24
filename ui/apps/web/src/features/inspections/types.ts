export interface OccupancyContact {
  name: string;
  phone: string;
  role: string;
}

export interface Occupancy {
  occupancyId: string;
  address: string;
  occupancyType: string;
  contacts: OccupancyContact[];
  hazards: string[];
  latitude?: number;
  longitude?: number;
}

export interface CreateOccupancyInput {
  address: string;
  occupancyType: string;
  contacts: OccupancyContact[];
  hazards: string[];
  latitude?: number;
  longitude?: number;
}

export interface UpdateOccupancyInput {
  contacts?: OccupancyContact[];
  hazards?: string[];
}

export interface UtilityShutoff {
  utility: string;
  location: string;
}

export interface PrePlanUploadUrl {
  filename: string;
  uploadUrl: string;
}

export interface PrePlanView {
  prePlanId: string;
  siteDiagramS3Key: string | null;
  siteDiagramUrl?: string;
  attachmentS3Keys: string[];
  attachmentUrls: { key: string; url: string }[];
  utilityShutoffs: UtilityShutoff[];
  hazards: string[];
}

export interface PutPrePlanResult {
  prePlanId: string;
  siteDiagramUploadUrl?: string;
  attachmentUploadUrls: PrePlanUploadUrl[];
  utilityShutoffs: UtilityShutoff[];
  hazards: string[];
}

export interface PutPrePlanInput {
  siteDiagramFilename?: string;
  attachmentFilenames: string[];
  utilityShutoffs: UtilityShutoff[];
  hazards: string[];
}

export type HydrantStatus = 'IN_SERVICE' | 'OUT_OF_SERVICE';

export interface Hydrant {
  hydrantId: string;
  latitude: number;
  longitude: number;
  size: string;
  flowRatingGpm: number;
  lastFlowTestDate?: string;
  nextFlowTestDue: string;
  status: HydrantStatus;
}

export interface CreateHydrantInput {
  hydrantId: string;
  latitude: number;
  longitude: number;
  size: string;
  flowRatingGpm: number;
  nextFlowTestDue: string;
  status?: HydrantStatus;
}

export interface UpdateHydrantInput {
  status?: HydrantStatus;
  lastFlowTestDate?: string;
  nextFlowTestDue?: string;
}

export type ViolationStatus = 'open' | 'resolved';

export interface Violation {
  code: string;
  description: string;
  status: ViolationStatus;
}

export interface Inspection {
  occupancyId: string;
  inspectionId: string;
  scheduledDate: string;
  conductedDate?: string;
  conductedBy?: string;
  violations: Violation[];
  photoS3Keys?: string[];
  nextDueDate: string;
}

export interface MapOccupancy {
  occupancyId: string;
  latitude: number;
  longitude: number;
}

export interface MapHydrant {
  hydrantId: string;
  latitude: number;
  longitude: number;
  status: HydrantStatus;
}

export interface MapQueryResult {
  occupancies: MapOccupancy[];
  hydrants: MapHydrant[];
}

export interface BoundingBox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}
