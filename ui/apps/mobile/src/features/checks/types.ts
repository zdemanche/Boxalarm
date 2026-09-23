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
}

export interface ChecklistTemplate {
  templateId: string;
  name: string;
  items: ChecklistItem[];
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
}

export type DefectSeverity = 'MINOR' | 'MAJOR' | 'OUT_OF_SERVICE';

export interface DefectSubmission {
  apparatusId: string;
  description: string;
  severity: DefectSeverity;
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
