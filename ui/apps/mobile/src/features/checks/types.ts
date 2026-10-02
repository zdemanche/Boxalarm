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
   * OK". Set per item on the web check sheet; a cached sheet from before the flag lacks it. */
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
  /** How it was answered: on its own, or by "Mark the other N OK". The server refuses BULK (or
   * no answer) on an item the sheet marks critical. */
  answeredBy: 'ITEM' | 'BULK';
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
  /** The check-sheet item a truck-check failure is filed against; absent when hand-typed. */
  itemCode?: string;
  photoLocalUri?: string;
  photoFileName?: string;
}

/** GET apparatus/{unitId} openDefects entry (apparatus-service apparatusRepository.ts). */
export interface OpenDefect {
  defectId: string;
  description: string;
  severity: DefectSeverity;
  reportedAt: number;
  /** Check-sheet item it was filed against; null/absent for hand-typed (or older) defects. */
  itemCode?: string | null;
}

export interface ChecksRepository {
  getApparatus(): Promise<Apparatus[]>;
  /** Open defects on a unit, so a check doesn't re-file one that is already reported. Optional:
   * the mock has none. Needs a connection (no offline cache). */
  getOpenDefects?(unitId: string): Promise<OpenDefect[]>;
  getChecklistTemplate(apparatusId: string): Promise<ChecklistTemplate>;
  // Optimistic local-first (N4.2): resolves immediately from the local store: no step in the
  // checklist waits on a network round trip. A real implementation queues to the outbox here;
  // the mock just "writes" synchronously, which is the same UX contract.
  submitChecklistRun(run: ChecklistRunSubmission): Promise<void>;
  submitDefect(defect: DefectSubmission): Promise<void>;
  /** Queues a photo taken on a check item that passed, attached to the run by its idempotency
   * key (a failed item's photo goes with its defect instead). Optional: the mock drops it. */
  submitCheckPhoto?(photo: CheckPhotoSubmission): Promise<void>;
}

export interface CheckPhotoSubmission {
  apparatusId: string;
  /** The run's idempotencyKey. */
  checkKey: string;
  itemCode: string;
  photoLocalUri: string;
  photoFileName: string;
}
