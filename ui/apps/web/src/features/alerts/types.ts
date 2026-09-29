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

/**
 * How the server tied the pre-plan to this dispatch (alerting dispatches/detail/prePlanContext.ts).
 * Only ADDRESS / ADDRESS_BUILDING are this building's own plan; the rest must be shown as
 * "verify address", never as the call's plan.
 */
export type PrePlanMatchType =
  'ADDRESS' | 'ADDRESS_BUILDING' | 'UNIT_MISMATCH' | 'NEARBY' | 'CANDIDATES';

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
  summary?: string;
  hazards: string[];
  utilityShutoffs: UtilityShutoff[];
  nearestHydrants: NearestHydrant[];
  candidates?: PrePlanCandidate[];
}

export type ToneLadderStatus = 'ACTIVE' | 'HALTED_MANUAL' | 'COMPLETED';

/** GET /alerting/dispatches/{id} `toneLadder` (F1.14). */
export interface ToneLadder {
  status: ToneLadderStatus | string;
  currentToneSequence: number;
  nextToneAt: number | null;
}

/** The MUTUAL_AID_EVENT projection (F1.13). */
export interface MutualAid {
  triggeredAt: number | null;
  reason: string | null;
  triggeredBy: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: number | null;
  notes: string | null;
}

export interface DispatchAlert {
  dispatchId: string;
  incidentType: string;
  address: string;
  crossStreets: string;
  mapLink: string | null;
  narrative: string;
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
  toneLadder?: ToneLadder;
  /** null = not requested; absent = the server could not read it (state unknown). */
  mutualAid?: MutualAid | null;
}

export interface AdvanceToneResult {
  dispatchId: string;
  toneSequence: number;
  outcome: string;
}

export interface HaltToneLadderResult {
  dispatchId: string;
  toneLadder: { status: string; currentToneSequence: number };
  changed: boolean;
}

export interface TriggerMutualAidResult {
  dispatchId: string;
  created: boolean;
  /**
   * Officers pushed by this request. On a repeat (created=false) these are re-sends to
   * officers an earlier attempt missed. null only from a server that predates re-sends.
   */
  officersNotified: number | null;
  mutualAid: MutualAid | null;
}

export interface AcknowledgeMutualAidResult {
  dispatchId: string;
  changed: boolean;
  mutualAid: MutualAid;
}

/** One row of GET alerting/dispatches?status=active (dispatches/list/handler.ts). */
export interface ActiveDispatch {
  dispatchId: string;
  incidentType: string | null;
  address: string | null;
  crossStreets: string | null;
  /** Epoch seconds. */
  dispatchedAt: number;
  toneLadder: { status: string; currentToneSequence: number };
}

/**
 * "Active" is a server-side recency window (the alerting plane has no cleared state), so the
 * response carries the window it applied — render it rather than implying a lifecycle state.
 */
export interface ActiveDispatchList {
  dispatches: ActiveDispatch[];
  activeWindowSeconds: number;
  /** Epoch seconds the window was evaluated at. */
  asOf: number;
  truncated: boolean;
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

export type TimelineEntityType =
  'DELIVERY_RECEIPT' | 'ESCALATION_EVENT' | 'DISPATCH_RESPONSE_RECORD';

// Raw items from the DISPATCH pk (alerting-service audit/queryAuditLog.ts
// queryMemberDispatchTimeline) - fields present depend on entityType, so most are optional.
export interface DiagnosticsTimelineEntry {
  entityType: TimelineEntityType | string;
  channel?: string;
  toneSequence?: number;
  status?: string;
  sentAt?: number;
  deliveredAt?: number | null;
  openedAt?: number | null;
  failureReason?: string | null;
  escalatedAt?: number;
  reason?: string;
  answeredAt?: number;
  ackStatus?: string;
}

export interface DeviceState {
  memberId: string;
  notificationPermission: boolean;
  criticalAlertPermission: boolean;
  batteryOptimizationExempt: boolean;
  appVersion: string;
  osVersion: string;
  reportedAt: number;
}

export type Diagnosis = 'ON_ROSTER' | 'NOT_ON_ELIGIBLE_ROSTER';

export interface DiagnosticsResult {
  dispatchId: string;
  memberId: string;
  diagnosis: Diagnosis;
  timeline: DiagnosticsTimelineEntry[];
  deviceState: DeviceState | null;
}

export type CanaryResult = 'PASS' | 'FAIL';

export interface CanaryRun {
  ranAt: number;
  result: CanaryResult;
  latencyMs: number;
  channelResults: Record<string, unknown>;
}

export interface CanaryStatus {
  healthy: boolean;
  latestResult: CanaryResult | null;
  latestLatencyMs: number | null;
  latestRanAt: number | null;
  runs: CanaryRun[];
}
