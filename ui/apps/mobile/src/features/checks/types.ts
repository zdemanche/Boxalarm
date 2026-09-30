// Shaped to match architecture.md's APPARATUS, CHECKLIST_TEMPLATE, CHECKLIST_RUN, and DEFECT
// entities (Data Model §3.3), so swapping the mock repository for @boxalarm/core's real
// offline-sync-backed client later is a data-layer change, not a screen rewrite.

export type ApparatusStatus = 'IN_SERVICE' | 'OUT_OF_SERVICE';

export interface Apparatus {
  apparatusId: string;
  unitId: string;
  type: string;
  status: ApparatusStatus;
}

export interface ChecklistItem {
  code: string;
  label: string;
  requiresPhoto: boolean;
  /** Must be answered one by one (brakes, SCBA pressure): never included in "Mark the other N
   * OK". The checklist API doesn't send this flag yet, so today it is always absent. */
  critical?: boolean;
}

export interface ChecklistTemplate {
  templateId: string;
  name: string;
  items: ChecklistItem[];
  /** Client-only: epoch ms of the cached copy when the sheet was served from this phone because
   * the server couldn't be reached. Absent on a live response. */
  cachedAt?: number;
}

export interface ItemResult {
  code: string;
  pass: boolean;
  note?: string;
}

export interface ChecklistRunSubmission {
  apparatusId: string;
  templateId: string;
  durationSeconds: number;
  itemResults: ItemResult[];
  idempotencyKey: string;
  capturedOffline?: boolean;
}

export type DefectSeverity = 'MINOR' | 'MAJOR' | 'OUT_OF_SERVICE';

export interface DefectSubmission {
  apparatusId: string;
  description: string;
  severity: DefectSeverity;
  idempotencyKey: string;
  photoLocalUri?: string;
  photoFileName?: string;
}

export interface ChecksRepository {
  getApparatus(): Promise<Apparatus[]>;
  getChecklistTemplate(apparatusId: string): Promise<ChecklistTemplate>;
  // Optimistic local-first (N4.2): resolves immediately from the local store: no step in the
  // checklist waits on a network round trip. A real implementation queues to the outbox here;
  // the mock just "writes" synchronously, which is the same UX contract.
  submitChecklistRun(run: ChecklistRunSubmission): Promise<void>;
  submitDefect(defect: DefectSubmission): Promise<void>;
}
