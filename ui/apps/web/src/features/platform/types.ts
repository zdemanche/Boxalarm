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
  /** This source's own webhook address: {webhookUrl}/{keyId}. */
  webhookEndpoint?: string | null;
  webhookRotatedAt: string | null;
  parser: { version: number; fields: CadParserFields } | null;
  /** IANA zone the CAD writes its times in (default America/New_York). */
  timeZone?: string;
}

export interface CadSourcesResponse {
  version: number | null;
  emailDomain: string | null;
  webhookUrl: string | null;
  sources: CadSourceView[];
  /** Non-blocking warnings about the saved sources (e.g. no incident number rule). */
  warnings?: { field: string; message: string }[];
  /**
   * PUT only: this many removed sources' webhook secrets could not be deleted - an old key is
   * still alive. Saving again retries the cleanup.
   */
  secretCleanupFailed?: number;
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
  timeZone?: string;
}

/** How ingress would order updates by the dispatch time (chain review R3-M1). */
interface CadTimeResolution {
  dispatchTimeResolved?: string;
  dispatchTimeUnordered?: boolean;
}

export type CadTestParseResult =
  | ({ status: 'PARSED'; fields: Partial<Record<CadField, string>> } & CadTimeResolution)
  | ({
      status: 'RAW';
      reason: string;
      fields: Partial<Record<CadField, string>>;
    } & CadTimeResolution);

/** POST .../webhook-key: the new key, shown once. */
export interface RotatedWebhookKey {
  keyId: string;
  secret: string;
  /** The source's own API Gateway key (its throttle bucket), sent as x-api-key. Shown once. */
  apiKey: string;
  rotatedAt: string;
  previousKeyStillValid: boolean;
  /** When the key this rotation replaced stops working (ISO), if there was one. */
  previousKeyExpiresAt: string | null;
  webhookUrl: string | null;
}
