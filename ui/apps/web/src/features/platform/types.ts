export const EDITABLE_CONFIG_TYPES = [
  'STATIONS',
  'RANKS',
  'LOSAP_POINT_RULES',
  'ALERT_RULES',
  'CHECKLIST_DEFAULTS',
] as const;

export type EditableConfigType = (typeof EDITABLE_CONFIG_TYPES)[number];

export interface ConfigResponse {
  configType: string;
  value: Record<string, unknown>;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export interface FieldError {
  field: string;
  message: string;
}

export interface AuditEntry {
  actorId: string;
  ts: number;
  action: string;
  mutatedEntityType: string;
  mutatedEntityId: string;
  changedFields: Record<string, unknown>;
}

export interface AuditPage {
  entries: AuditEntry[];
  nextCursor?: string;
}

export type ExportStatus =
  | { status: 'PENDING' }
  | { status: 'FAILED' }
  | { status: 'COMPLETE'; files: { table: string; url: string }[] };

export interface RetentionConfig {
  retentionYears: number;
  version?: number;
  source: 'stored' | 'default';
}

export interface DisposalResult {
  retentionYearsUsed: number;
  hardDeleted: number;
  cryptoShredded: number;
  refused: string[];
}

export const LIFE_SAFETY_RECORD_CLASSES = [
  'DELIVERY_RECEIPT',
  'DISPATCH_ALERT',
  'AUDIT_LOG_ENTRY',
  'NERIS_SUBMISSION_ATTEMPT',
] as const;
