import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import {
  isTimeZone,
  validateCadParserTemplate,
  type CadParserTemplate,
} from '@boxalarm/cad-parser';

/**
 * CAD_INGRESS_COPY: the department's CAD sources as the ingress Lambdas read them
 * (`DEPT#{deptId}#CAD_INGRESS / METADATA`). Written only by the alerting-owned consumer of
 * `platform.config.updated` (sourceCopyHandler.ts), the same projection pattern as
 * ALERT_RULES_COPY: the alerting plane never reads the LOB table.
 *
 * The department is ALWAYS the partition this copy was read from, which the ingress path
 * chose from the authenticated source id - never a field in the message (cad-ingress-auth
 * rule 4).
 */

export interface CadEmailSource {
  /** Sender domains ("cad.county.gov") or addresses ("dispatch@cad.county.gov"), lower case. */
  readonly allowedSenders: readonly string[];
  /** Random part of the recipient address; noise reduction only, not authentication. */
  readonly recipientToken: string;
}

export interface CadWebhookSource {
  /** Value of the X-Boxalarm-Source header: `{deptId}.{sourceId}`. */
  readonly keyId: string;
  /** Secrets Manager secret holding { current, previous } HMAC keys. */
  readonly secretName: string;
}

export interface CadSourceCopy {
  readonly sourceId: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly email?: CadEmailSource;
  readonly webhook?: CadWebhookSource;
  readonly parser?: CadParserTemplate;
  /** IANA zone the CAD's times are written in (default America/New_York). */
  readonly timeZone?: string;
}

export const CAD_SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DEPT_ID_IN_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const RECIPIENT_TOKEN = /^[a-z0-9]{12,64}$/;

export function cadIngressCopyKey(deptId: VerifiedDeptId): { pk: string; sk: string } {
  return { pk: buildDeptScopedPk(deptId, 'CAD_INGRESS'), sk: 'METADATA' };
}

export function sourceKeyId(deptId: string, sourceId: string): string {
  return `${deptId}.${sourceId}`;
}

/** `{deptId}.{sourceId}` -> its parts, or undefined for anything else. */
export function parseSourceKeyId(
  keyId: string | undefined,
): { readonly deptId: VerifiedDeptId; readonly sourceId: string } | undefined {
  if (!keyId || keyId.length > 100) return undefined;
  const dot = keyId.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const deptId = keyId.slice(0, dot);
  const sourceId = keyId.slice(dot + 1);
  if (!DEPT_ID_IN_KEY.test(deptId) || !CAD_SOURCE_ID.test(sourceId)) return undefined;
  return { deptId: toVerifiedDeptId({ deptId }), sourceId };
}

/**
 * The recipient local part `dispatch+{deptId}.{sourceId}.{token}` -> its parts. The domain is
 * checked by the caller.
 */
export function parseRecipientLocalPart(
  localPart: string,
):
  | { readonly deptId: VerifiedDeptId; readonly sourceId: string; readonly token: string }
  | undefined {
  const plus = localPart.indexOf('+');
  if (plus < 0) return undefined;
  const tag = localPart.slice(plus + 1);
  const dot = tag.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const token = tag.slice(dot + 1);
  const key = parseSourceKeyId(tag.slice(0, dot));
  if (!key || !RECIPIENT_TOKEN.test(token)) return undefined;
  return { ...key, token };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One source from the copy, re-validated on read: a malformed entry is treated as no source
 * (the message then fails closed), never partly trusted.
 */
export function toCadSource(raw: unknown): CadSourceCopy | undefined {
  if (!isRecord(raw)) return undefined;
  const { sourceId, label, enabled, email, webhook, parser, timeZone } = raw;
  if (typeof sourceId !== 'string' || !CAD_SOURCE_ID.test(sourceId)) return undefined;
  let emailSource: CadEmailSource | undefined;
  if (isRecord(email)) {
    const senders = Array.isArray(email.allowedSenders)
      ? email.allowedSenders.filter((s): s is string => typeof s === 'string' && s.length > 0)
      : [];
    if (typeof email.recipientToken === 'string' && RECIPIENT_TOKEN.test(email.recipientToken)) {
      emailSource = {
        allowedSenders: senders.map((s) => s.toLowerCase()),
        recipientToken: email.recipientToken,
      };
    }
  }
  let webhookSource: CadWebhookSource | undefined;
  if (
    isRecord(webhook) &&
    typeof webhook.keyId === 'string' &&
    typeof webhook.secretName === 'string' &&
    webhook.secretName.length > 0
  ) {
    webhookSource = { keyId: webhook.keyId, secretName: webhook.secretName };
  }
  const template = parser === undefined ? undefined : validateCadParserTemplate(parser);
  return {
    sourceId,
    label: typeof label === 'string' ? label : sourceId,
    enabled: enabled === true,
    ...(emailSource ? { email: emailSource } : {}),
    ...(webhookSource ? { webhook: webhookSource } : {}),
    ...(isTimeZone(timeZone) ? { timeZone } : {}),
    // An invalid stored template is dropped: the source still pages, as RAW (fail open).
    ...(template?.ok ? { parser: template.template } : {}),
  };
}

export async function loadCadSource(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  sourceId: string,
): Promise<CadSourceCopy | undefined> {
  const { Item } = await client.send(
    new GetCommand({ TableName: tableName, Key: cadIngressCopyKey(deptId), ConsistentRead: true }),
  );
  const sources = Array.isArray(Item?.sources) ? (Item.sources as unknown[]) : [];
  const source = sources.map(toCadSource).find((s) => s?.sourceId === sourceId);
  return source?.enabled ? source : undefined;
}
