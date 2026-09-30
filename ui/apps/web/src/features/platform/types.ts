export const EDITABLE_CONFIG_TYPES = [
  'STATIONS',
  'RANKS',
  'LOSAP_POINT_RULES',
  'ALERT_RULES',
  'CHECKLIST_DEFAULTS',
  'NERIS',
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

/** One push registration as an admin sees it - never the token. */
export interface MemberDevice {
  /** The app's installation id; null for a registration from before the app sent one. */
  deviceId: string | null;
  /** APNS (iPhone) or FCM (Android). */
  platform: string | null;
  /** Epoch milliseconds of the last registration from this device. */
  registeredAt: number | null;
  /** False once the push provider rejected the token. */
  valid: boolean;
}

export interface MemberDevices {
  memberId: string;
  devices: MemberDevice[];
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
