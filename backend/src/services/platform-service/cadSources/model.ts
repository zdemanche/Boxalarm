import { randomInt } from 'node:crypto';
import {
  CAD_FIELDS,
  validateCadParserTemplate,
  type CadField,
  type CadFieldRule,
  type CadParserTemplate,
} from '@boxalarm/cad-parser';

/**
 * The department's CAD ingress sources (DEPARTMENT_CONFIG, configType CAD_INGRESS), as the
 * chief edits them and as they are stored.
 *
 * The STORED shape is what the alerting plane's projection reads (alerting-service
 * cadIngress/sourceCopy.ts `toCadSource`), so it is fixed here:
 *   { sourceId, label, enabled,
 *     email?:   { allowedSenders, recipientToken },          // present iff email is on
 *     webhook?: { keyId, secretName },                       // present iff on AND keyed
 *     webhookKey?: { keyId, secretName, rotatedAt },         // key metadata, kept when off
 *     parser?:  { version, fields } }
 *
 * Server-managed, never taken from the request: recipientToken (generated once), the webhook
 * key reference (set only by the rotation route) and the parser version (bumped whenever the
 * template changes, so every dispatch records which template read it).
 */

export const MAX_SOURCES = 10;
const MAX_SENDERS = 20;
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL_PART = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

export interface WebhookKeyRef {
  readonly keyId: string;
  readonly secretName: string;
  readonly rotatedAt: string;
  /** The source's current API Gateway API key id (its throttle bucket; not a secret). */
  readonly apiKeyId?: string;
  /** The API key the last rotation replaced, deleted by the next rotation or a revoke. */
  readonly previousApiKeyId?: string;
}

export interface StoredCadSource {
  readonly sourceId: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly email?: { readonly allowedSenders: readonly string[]; readonly recipientToken: string };
  readonly webhook?: { readonly keyId: string; readonly secretName: string };
  readonly webhookKey?: WebhookKeyRef;
  /** The chief's switch; `webhook` is only present when this is on and a key exists. */
  readonly webhookEnabled: boolean;
  /** Email off: the address token and senders are kept so re-enabling keeps the address. */
  readonly emailToken?: string;
  readonly savedSenders?: readonly string[];
  readonly parser?: CadParserTemplate;
}

export interface CadIngressValue {
  readonly sources: readonly StoredCadSource[];
}

/** One source as the chief submits it. */
export interface CadSourceInput {
  readonly sourceId: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly emailEnabled: boolean;
  readonly allowedSenders: readonly string[];
  readonly webhookEnabled: boolean;
  readonly parserFields?: Partial<Record<CadField, CadFieldRule>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A sender domain ("cad.county.gov") or address ("dispatch@cad.county.gov"). */
export function isValidSender(value: string): boolean {
  const at = value.lastIndexOf('@');
  if (at < 0) return DOMAIN.test(value);
  return LOCAL_PART.test(value.slice(0, at)) && DOMAIN.test(value.slice(at + 1));
}

export function validateParserFields(
  raw: unknown,
  prefix: string,
):
  | { ok: true; fields: Partial<Record<CadField, CadFieldRule>> }
  | { ok: false; errors: FieldError[] } {
  const result = validateCadParserTemplate({ version: 1, fields: raw }, prefix);
  return result.ok
    ? { ok: true, fields: result.template.fields }
    : { ok: false, errors: result.errors };
}

const INPUT_KEYS = [
  'sourceId',
  'label',
  'enabled',
  'emailEnabled',
  'allowedSenders',
  'webhookEnabled',
  'parser',
];

/** Validates `PUT /platform/cad-sources` `{ sources: [...] }`. */
export function validateSourcesInput(
  body: unknown,
): { ok: true; sources: CadSourceInput[] } | { ok: false; errors: FieldError[] } {
  if (!isRecord(body) || !Array.isArray(body.sources)) {
    return {
      ok: false,
      errors: [{ field: 'sources', message: 'is required and must be an array' }],
    };
  }
  const errors: FieldError[] = [];
  if (body.sources.length > MAX_SOURCES) {
    errors.push({ field: 'sources', message: `must have at most ${MAX_SOURCES} sources` });
  }
  const seen = new Set<string>();
  const sources: CadSourceInput[] = [];
  body.sources.forEach((raw, index) => {
    const at = `sources[${index}]`;
    if (!isRecord(raw)) {
      errors.push({ field: at, message: 'must be an object' });
      return;
    }
    for (const key of Object.keys(raw)) {
      if (!INPUT_KEYS.includes(key)) {
        errors.push({ field: `${at}.${key}`, message: 'is not a recognized field' });
      }
    }
    const { sourceId, label, enabled, emailEnabled, webhookEnabled, allowedSenders, parser } = raw;
    if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId)) {
      errors.push({
        field: `${at}.sourceId`,
        message:
          'must be 1-32 lower-case letters, digits or dashes, starting with a letter or digit',
      });
    } else if (seen.has(sourceId)) {
      errors.push({ field: `${at}.sourceId`, message: 'is used by another source' });
    } else {
      seen.add(sourceId);
    }
    if (typeof label !== 'string' || label.trim().length === 0 || label.length > 80) {
      errors.push({ field: `${at}.label`, message: 'must be 1-80 characters' });
    }
    for (const [name, value] of [
      ['enabled', enabled],
      ['emailEnabled', emailEnabled],
      ['webhookEnabled', webhookEnabled],
    ] as const) {
      if (typeof value !== 'boolean') {
        errors.push({ field: `${at}.${name}`, message: 'must be true or false' });
      }
    }
    const senders: string[] = [];
    if (!Array.isArray(allowedSenders) || allowedSenders.length > MAX_SENDERS) {
      errors.push({
        field: `${at}.allowedSenders`,
        message: `must be a list of at most ${MAX_SENDERS} sender domains or addresses`,
      });
    } else {
      allowedSenders.forEach((sender, i) => {
        const normalized = typeof sender === 'string' ? sender.trim().toLowerCase() : '';
        if (!isValidSender(normalized)) {
          errors.push({
            field: `${at}.allowedSenders[${i}]`,
            message: 'must be a domain (cad.county.gov) or an address (dispatch@cad.county.gov)',
          });
        } else {
          senders.push(normalized);
        }
      });
    }
    if (emailEnabled === true && Array.isArray(allowedSenders) && allowedSenders.length === 0) {
      errors.push({
        field: `${at}.allowedSenders`,
        message: 'email needs at least one allowed sender: there is no accept-anyone mode',
      });
    }
    let parserFields: Partial<Record<CadField, CadFieldRule>> | undefined;
    if (parser !== undefined && parser !== null) {
      const parsed = validateParserFields(
        isRecord(parser) ? parser.fields : undefined,
        `${at}.parser`,
      );
      if (parsed.ok) parserFields = parsed.fields;
      else errors.push(...parsed.errors);
    }
    sources.push({
      sourceId: String(sourceId),
      label: typeof label === 'string' ? label.trim() : '',
      enabled: enabled === true,
      emailEnabled: emailEnabled === true,
      allowedSenders: [...new Set(senders)],
      webhookEnabled: webhookEnabled === true,
      ...(parserFields ? { parserFields } : {}),
    });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, sources };
}

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newRecipientToken(length = 16): string {
  return Array.from({ length }, () => TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)]).join('');
}

function sameFields(
  a: Partial<Record<CadField, CadFieldRule>> | undefined,
  b: Partial<Record<CadField, CadFieldRule>> | undefined,
): boolean {
  const canonical = (fields: Partial<Record<CadField, CadFieldRule>> | undefined) =>
    JSON.stringify(
      CAD_FIELDS.filter((field) => fields?.[field]).map((field) => [field, fields?.[field]]),
    );
  return canonical(a) === canonical(b);
}

/** A stored source read back defensively (older or hand-edited items). */
export function readStoredSources(value: Record<string, unknown> | undefined): StoredCadSource[] {
  const list = Array.isArray(value?.sources) ? (value.sources as unknown[]) : [];
  return list.filter(isRecord).map((raw) => raw as unknown as StoredCadSource);
}

/** The value to store: the chief's input merged with the server-managed fields. */
export function mergeSources(
  input: readonly CadSourceInput[],
  stored: readonly StoredCadSource[],
  newToken: () => string = newRecipientToken,
): CadIngressValue {
  const previous = new Map(stored.map((source) => [source.sourceId, source]));
  return {
    sources: input.map((source): StoredCadSource => {
      const old = previous.get(source.sourceId);
      const recipientToken = old?.email?.recipientToken ?? old?.emailToken ?? newToken();
      const parserVersion =
        old?.parser && sameFields(old.parser.fields, source.parserFields)
          ? old.parser.version
          : (old?.parser?.version ?? 0) + 1;
      const webhookKey = old?.webhookKey;
      return {
        sourceId: source.sourceId,
        label: source.label,
        enabled: source.enabled,
        ...(source.emailEnabled
          ? { email: { allowedSenders: source.allowedSenders, recipientToken } }
          : {}),
        // Kept while email is off so re-enabling it keeps the same address.
        ...(!source.emailEnabled
          ? { emailToken: recipientToken, savedSenders: source.allowedSenders }
          : {}),
        webhookEnabled: source.webhookEnabled,
        ...(webhookKey ? { webhookKey } : {}),
        ...(source.webhookEnabled && webhookKey
          ? { webhook: { keyId: webhookKey.keyId, secretName: webhookKey.secretName } }
          : {}),
        ...(source.parserFields
          ? { parser: { version: parserVersion, fields: source.parserFields } }
          : {}),
      };
    }),
  };
}

/** Applies a rotated key to one stored source. */
export function withWebhookKey(
  stored: readonly StoredCadSource[],
  sourceId: string,
  key: WebhookKeyRef,
): StoredCadSource[] {
  return stored.map((source) => {
    if (source.sourceId !== sourceId) return source;
    const rest: StoredCadSource = { ...source };
    delete (rest as { webhook?: unknown }).webhook;
    return {
      ...rest,
      webhookKey: key,
      ...(source.webhookEnabled
        ? { webhook: { keyId: key.keyId, secretName: key.secretName } }
        : {}),
    };
  });
}

/** What GET returns: no secret, no secret name - the token only as part of the address. */
export function toSourceView(
  source: StoredCadSource,
  deptId: string,
  emailDomain: string | undefined,
) {
  const token = source.email?.recipientToken ?? source.emailToken;
  return {
    sourceId: source.sourceId,
    label: source.label,
    enabled: source.enabled,
    emailEnabled: source.email !== undefined,
    allowedSenders: source.email?.allowedSenders ?? source.savedSenders ?? [],
    emailAddress:
      emailDomain && token ? `dispatch+${deptId}.${source.sourceId}.${token}@${emailDomain}` : null,
    webhookEnabled: source.webhookEnabled === true,
    webhookKeyId: source.webhookKey?.keyId ?? null,
    webhookRotatedAt: source.webhookKey?.rotatedAt ?? null,
    parser: source.parser ?? null,
  };
}

/**
 * Non-blocking warnings about a saved source, returned by GET and PUT (chain review C1). A
 * source whose template reads no incident number is identified by its text alone: an identical
 * resend within 10 minutes is dropped, and CAD updates to a call cannot be recognised as
 * updates. It still pages - this is a warning, not a block.
 */
export function sourceWarnings(source: StoredCadSource, index: number): FieldError[] {
  if (source.parser?.fields.incidentNumber) return [];
  return [
    {
      field: `sources[${index}].parser.fields.incidentNumber`,
      message:
        'no incident number rule: dispatches are told apart by their text only, so an identical resend within 10 minutes is dropped and CAD updates page as new calls. Add an incident number rule if the CAD sends one.',
    },
  ];
}
