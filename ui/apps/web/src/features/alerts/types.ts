export type AckStatus = 'RESPONDING' | 'NOT_RESPONDING' | 'DIRECT_TO_SCENE' | 'UNANSWERED';

export interface RosterEntry {
  memberId: string;
  name: string;
  ackStatus: AckStatus;
  eta: number | null;
  assignedApparatusId: string | null;
  quals: string[];
  lastAnsweredTone: number | null;
}

export interface UtilityShutoff {
  utility: string;
  location: string;
}

export interface NearestHydrant {
  hydrantId: string;
  status?: string;
  size?: string;
  flowRatingGpm?: number;
}

export interface PrePlanEnrichment {
  summary?: string;
  hazards: string[];
  utilityShutoffs: UtilityShutoff[];
  nearestHydrants: NearestHydrant[];
}

export interface DispatchAlert {
  dispatchId: string;
  incidentType: string;
  address: string;
  crossStreets: string;
  mapLink: string | null;
  narrative: string;
  prePlan?: PrePlanEnrichment | null;
}

export type DeliveryReceiptStatus = 'FAILED' | 'OPENED' | 'DELIVERED' | 'SENT_UNCONFIRMED' | 'SENT';

export interface DeliveryReceipt {
  memberId: string;
  channel: string;
  toneSequence: number;
  status: DeliveryReceiptStatus;
  sentAt: number;
  deliveredAt: number | null;
  openedAt: number | null;
  failureReason: string | null;
}

export interface ManualDispatchInput {
  incidentType: string;
  address: string;
  crossStreets: string;
  unitsRequested: string[];
  narrative: string;
  externalDispatchId: string;
}

export interface FieldError {
  field: string;
  message: string;
}

export type SeatQualStatus = 'MET' | 'UNMET' | 'NO_REQUIREMENT';

export interface RidingSeatAssignment {
  memberId: string;
  version: number;
  assignedAt: number;
  assignedBy: string;
  qualStatus: SeatQualStatus;
}

export interface RidingSeatPosition {
  code: string;
  label: string;
  requiredQual?: string;
  assignment?: RidingSeatAssignment;
}

export interface RidingBoardApparatus {
  apparatusId: string;
  unitId: string;
  type: string;
  status: 'IN_SERVICE' | 'OUT_OF_SERVICE';
  assignable: boolean;
  outOfServiceReason?: string;
  positions: RidingSeatPosition[];
}

export interface RidingBoard {
  dispatchId: string;
  apparatus: RidingBoardApparatus[];
}
