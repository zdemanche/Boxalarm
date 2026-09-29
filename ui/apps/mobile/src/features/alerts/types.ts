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

/** NFPA 291 hydrant marking class (rated flow): AA >=1500, A 1000-1499, B 500-999, C <500 gpm. */
export type HydrantFlowClass = 'AA' | 'A' | 'B' | 'C';

// Nearest hydrants to the matched occupancy, nearest first (alerting-service
// prePlan/nearestHydrants.ts): up to five usable ones, plus any OUT_OF_SERVICE hydrant nearer
// than the last of them (status says which). distanceMeters/flowClass are absent from older
// responses.
export interface NearestHydrant {
  hydrantId: string;
  status?: string;
  size?: string;
  flowRatingGpm?: number;
  flowClass?: HydrantFlowClass;
  distanceMeters?: number;
}

// E1-S17-UI / E5-S8-UI enrichment block, embedded in GET /dispatches/{dispatchId} - alerting
// route only (N1.5: never a separate call to /inspections/*).
/**
 * How the server tied the pre-plan to this dispatch (alerting dispatches/detail/prePlanContext.ts).
 * Only ADDRESS is this building's own plan. Everything else, ADDRESS_BUILDING included (the
 * building's plan for a unit that has none of its own), is shown flagged "VERIFY ADDRESS",
 * never as the call's plan.
 */
export type PrePlanMatchType =
  'ADDRESS' | 'ADDRESS_BUILDING' | 'ADDRESS_UNVERIFIED' | 'UNIT_MISMATCH' | 'NEARBY' | 'CANDIDATES';

/** One of several pre-plans the crew must choose between (matchType CANDIDATES). */
export interface PrePlanCandidate {
  occupancyId: string;
  matchedAddress: string;
  unit: string | null;
  summary?: string;
  hazards: string[];
  utilityShutoffs: UtilityShutoff[];
  distanceMeters?: number;
}

export interface PrePlanEnrichment {
  /** Absent only from a server that predates match provenance. */
  matchType?: PrePlanMatchType;
  matchedAddress?: string;
  unit?: string | null;
  /** NEARBY only: meters from the dispatch location. */
  distanceMeters?: number;
  /** ADDRESS_BUILDING: the dispatched unit ("BLDG 2", "REAR") the building-level plan does not cover. */
  dispatchUnit?: string;
  /**
   * Legacy line for clients without matchType support (the server prefixes it with the
   * provenance for anything but a plain ADDRESS match). Render occupancySummary instead
   * whenever matchType is present.
   */
  summary?: string;
  occupancySummary?: string;
  hazards: string[];
  utilityShutoffs: UtilityShutoff[];
  nearestHydrants: NearestHydrant[];
  candidates?: PrePlanCandidate[];
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
  /** The server could not look the pre-plan up (prePlan is then absent) - not "none on file". */
  prePlanUnavailable?: boolean;
  /**
   * Nearest hydrants to the matched building or the dispatch's own coordinates - present with
   * or without a pre-plan match; includes flagged OUT_OF_SERVICE hydrants. Absent when there
   * is no reference point (or from an older server).
   */
  nearestHydrants?: NearestHydrant[];
  nearestHydrantsUnavailable?: boolean;
  /** The server's geo read hit its cap: a nearer hydrant may be missing. */
  nearestHydrantsIncomplete?: boolean;
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

/** Where the incident is: a home town/village, or another town typed in (R3-A). */
export interface DispatchLocality {
  town: string;
  choice: 'HOME' | 'OTHER';
}

export interface ManualDispatchInput {
  incidentType: string;
  address: string;
  crossStreets: string;
  unitsRequested: string[];
  narrative: string;
  externalDispatchId: string;
  locality?: DispatchLocality;
}

/** GET alerting/home-locality: the department's home towns/villages. */
export interface HomeLocality {
  towns: string[];
  zips: string[];
  state: string | null;
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
  /** The manual-entry locality choices; callers treat a failure as "no home list". */
  getHomeLocality(): Promise<HomeLocality>;
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
