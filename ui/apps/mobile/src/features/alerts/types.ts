// Shaped to match architecture.md's alerting-service entities (Data Model, Backend API) and the
// merged alerting-service handlers (dispatches/detail, responses, roster, receipts, selfTest).

export type ToneLadderStatus = 'ACTIVE' | 'HALTED_MANUAL' | 'COMPLETED';

// F1.14: officer-visible, overridable escalation ladder - not a black box. Only present on the
// self-test flavor of a dispatch today; the real GET /dispatches/{id} response does not include
// it, so screens must treat this as optional.
export interface ToneLadder {
  status: ToneLadderStatus;
  currentToneSequence: number;
  nextToneAt: string | null; // ISO, null once COMPLETED
  predicateGaps: string[]; // e.g. "2 more responders," "1 more INTERIOR-qualified"
}

export type AckStatus = 'RESPONDING' | 'NOT_RESPONDING' | 'DIRECT_TO_SCENE' | 'UNANSWERED';

// F1.7: live roster is one row per member (not per channel).
export interface RosterEntry {
  memberId: string;
  name: string;
  ackStatus: AckStatus;
  eta: number | null; // epoch seconds
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

// E1-S17-UI / E5-S8-UI enrichment block, embedded in GET /dispatches/{dispatchId} - alerting
// route only (N1.5: never a separate call to /inspections/*).
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
  isSelfTest: boolean;
  toneLadder?: ToneLadder;
  prePlan?: PrePlanEnrichment | null;
}

export interface SelfTestChannelResult {
  ok: boolean;
  ms: number;
  reason?: string;
}

export interface SelfTestRun {
  testId: string;
  runAt: number | null;
  channelsTested: string[];
  channelResults: Record<string, SelfTestChannelResult>;
  overallResult: 'RUNNING' | 'PASS' | 'FAIL';
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

export interface AlertsRepository {
  triggerSelfTest(): Promise<{ testId: string; dispatchId: string }>;
  getSelfTestRun(testId: string): Promise<SelfTestRun>;
  getDispatch(dispatchId: string): Promise<DispatchAlert>;
  getRoster(dispatchId: string): Promise<RosterEntry[]>;
  submitResponse(dispatchId: string, ackStatus: AckStatus, etaMinutes?: number): Promise<void>;
  submitManualDispatch(input: ManualDispatchInput): Promise<{ dispatchId: string }>;
  getReceipts(dispatchId: string): Promise<DeliveryReceipt[]>;
  getRidingBoard(dispatchId: string): Promise<RidingBoard>;
  assignRidingSeat(
    dispatchId: string,
    seat: {
      unitId: string;
      positionCode: string;
      memberId: string | null;
      expectedVersion: number;
    },
  ): Promise<void>;
}
