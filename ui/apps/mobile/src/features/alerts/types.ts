// Shaped to match architecture.md's alerting-service entities (Data Model, Backend API).
// Self-test scope (Phase 7): real dispatch fan-out needs boxalarm-backend/boxalarm-infrastructure
// access this build doesn't have yet, so AlertsRepository is implemented against a mock that
// models a self-test round trip - the same shapes the real dispatch-received path will use.

export type ToneLadderStatus = 'ACTIVE' | 'HALTED_MANUAL' | 'COMPLETED';

// F1.14: officer-visible, overridable escalation ladder - not a black box.
export interface ToneLadder {
  status: ToneLadderStatus;
  currentToneSequence: number;
  nextToneAt: string | null; // ISO, null once COMPLETED
  predicateGaps: string[]; // e.g. "2 more responders," "1 more INTERIOR-qualified"
}

export type AckStatus = 'RESPONDING' | 'NOT_RESPONDING' | 'UNANSWERED';

// F1.7: live roster is one row per member (not per channel).
export interface RosterEntry {
  memberId: string;
  name: string;
  ackStatus: AckStatus;
  eta: string | null; // ISO
  assignedApparatusId: string | null;
  quals: string[];
  currentChannelTier: number;
  lastAnsweredTone: number | null;
}

export interface DispatchAlert {
  dispatchId: string;
  type: string;
  address: string;
  notes: string;
  isSelfTest: boolean;
  toneLadder: ToneLadder;
}

// F1.10: self-test end-to-end, reused as the canary payload.
export interface SelfTestResult {
  testId: string;
  dispatchId: string;
  status: 'DELIVERED' | 'FAILED';
}

export interface AlertsRepository {
  triggerSelfTest(): Promise<SelfTestResult>;
  getDispatch(dispatchId: string): Promise<DispatchAlert>;
  getRoster(dispatchId: string): Promise<RosterEntry[]>;
  // F1.6: response confirmation + ETA.
  submitResponse(dispatchId: string, ackStatus: AckStatus, eta?: string): Promise<void>;
}
