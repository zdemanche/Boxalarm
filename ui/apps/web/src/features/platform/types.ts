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

/** CAD ingress parser fields (backend @boxalarm/cad-parser CAD_FIELDS). */
export const CAD_FIELDS = [
  'incidentNumber',
  'dispatchTime',
  'incidentType',
  'address',
  'crossStreets',
  'town',
  'units',
  'narrative',
] as const;
export type CadField = (typeof CAD_FIELDS)[number];

/** One field's rule: a line label or a regex whose first capture group is the value. */
export type CadFieldRule = { label: string } | { pattern: string };
export type CadParserFields = Partial<Record<CadField, CadFieldRule>>;

/** GET /platform/cad-sources: one source, as the chief sees it (no secret, no secret name). */
export interface CadSourceView {
  sourceId: string;
  label: string;
  enabled: boolean;
  emailEnabled: boolean;
  allowedSenders: string[];
  emailAddress: string | null;
  webhookEnabled: boolean;
  webhookKeyId: string | null;
  webhookRotatedAt: string | null;
  parser: { version: number; fields: CadParserFields } | null;
}

export interface CadSourcesResponse {
  version: number | null;
  emailDomain: string | null;
  webhookUrl: string | null;
  sources: CadSourceView[];
  /** Non-blocking warnings about the saved sources (e.g. no incident number rule). */
  warnings?: { field: string; message: string }[];
}

/** PUT /platform/cad-sources: one source as the chief edits it. */
export interface CadSourceInput {
  sourceId: string;
  label: string;
  enabled: boolean;
  emailEnabled: boolean;
  allowedSenders: string[];
  webhookEnabled: boolean;
  parser?: { fields: CadParserFields };
}

export type CadTestParseResult =
  | { status: 'PARSED'; fields: Partial<Record<CadField, string>> }
  | { status: 'RAW'; reason: string; fields: Partial<Record<CadField, string>> };

/** POST .../webhook-key: the new key, shown once. */
export interface RotatedWebhookKey {
  keyId: string;
  secret: string;
  rotatedAt: string;
  previousKeyStillValid: boolean;
  webhookUrl: string | null;
}
