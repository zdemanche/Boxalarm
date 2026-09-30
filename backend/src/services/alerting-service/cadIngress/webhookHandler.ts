import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Handler,
} from 'aws-lambda';
import { CAD_FIELDS, type CadField, type CadParsedFields } from '@boxalarm/cad-parser';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError, logInfo } from '../dispatches/logger.js';
import { ingestCadDispatch } from './ingest.js';
import { emitCadMetric } from './metrics.js';
import { isReplayMarked } from './replayGuard.js';
import { loadCadSource, parseSourceKeyId } from './sourceCopy.js';
import { REPLAY_TTL_SECONDS, isFreshTimestamp, verifySignature } from './webhookAuth.js';
import { getWebhookKeys } from './webhookKeys.js';

/**
 * POST /api/v1/alerting/ingress/cad-webhook - the signed JSON CAD webhook. Outside Cognito:
 * it has its own API, stage and throttle (infrastructure cad-ingress.ts) and authenticates
 * with its own HMAC (webhookAuth.ts).
 *
 * Order of checks is the decision record's, and nothing in the body is read before step 4:
 *   0. body size (a non-trust limit, 413)
 *   1. source lookup from X-Boxalarm-Source (`{deptId}.{sourceId}`) in CAD_INGRESS_COPY
 *   2. timestamp within +-300 s
 *   3. signature over `${timestamp}.${rawBody}`, constant time, current or previous key
 *   4. replay check on the signature (409 on a replay; the marker is written atomically with
 *      the dispatch in step 5, so the check is re-made there)
 *   5. only then parse the body and write the dispatch (ingest.ts)
 * Every failure of 1-3 is the same generic 401 and a CadIngressAuthFailed{Reason} count: the
 * response never says which check failed. FAIL CLOSED - an unauthenticated request never
 * pages, not even as raw text. The department is the source's, never the body's.
 *
 * Returns as soon as the DISPATCH_ALERT write is durable (202); the stream fan-out pages.
 */

export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
const CHANNEL = 'cad-webhook';

type AuthFailure = 'UnknownSource' | 'StaleTimestamp' | 'NoActiveKey' | 'BadSignature';

function header(event: APIGatewayProxyEventV2, name: string): string | undefined {
  // HTTP API payload v2 lower-cases header names; a multi-valued header arrives comma-joined.
  return event.headers?.[name];
}

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function problem(
  status: number,
  title: string,
  traceId: string,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({ type: 'about:blank', title, status, traceId }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The dispatch in an authenticated body. Three shapes, none of which can fail:
 *  - JSON with CAD fields (`address`, `incidentNumber`, ... ; `units` may be an array):
 *    structured, used as sent;
 *  - JSON `{ "text": "..." }`: the text goes through the source's parser template;
 *  - anything else (not JSON, or JSON without either): the raw body is the dispatch text.
 * Any other key - a `deptId` included - is ignored.
 */
export function readWebhookBody(rawText: string): {
  readonly text: string;
  readonly structured?: CadParsedFields;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { text: rawText };
  }
  if (!isRecord(parsed)) return { text: rawText };
  const structured: CadParsedFields = {};
  for (const field of CAD_FIELDS) {
    const value = parsed[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      structured[field] = value.trim().slice(0, 4_000);
    } else if (field === 'units' && Array.isArray(value)) {
      const units = value.filter((unit): unit is string => typeof unit === 'string');
      if (units.length > 0) structured.units = units.join(', ');
    }
  }
  const text = typeof parsed.text === 'string' ? parsed.text : undefined;
  if (Object.keys(structured).length === 0) {
    return { text: text ?? rawText };
  }
  const rendered = (Object.entries(structured) as [CadField, string][])
    .map(([field, value]) => `${field}: ${value}`)
    .join('\n');
  return { text: text ?? rendered, structured };
}

export const handler: Handler<APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2> = async (
  event,
) => {
  const traceId = event.requestContext.requestId;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const rawBody = event.body
    ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8')
    : Buffer.alloc(0);
  if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
    emitCadMetric('CadIngressRejected', { Channel: CHANNEL, Reason: 'BodyTooLarge' });
    return problem(413, 'Payload too large', traceId);
  }

  const reject = (reason: AuthFailure, extra: Record<string, unknown> = {}) => {
    emitCadMetric('CadIngressAuthFailed', { Channel: CHANNEL, Reason: reason });
    // Never the body; the source header only as sent (it names no secret).
    logInfo('cadIngress.webhook.authFailed', { traceId, reason, ...extra });
    return problem(401, 'Unauthorized', traceId);
  };
  const unavailable = (reason: string, error: unknown) => {
    logError('cadIngress.webhook.unavailable', error, { traceId, reason });
    emitCadMetric('CadIngressRejected', { Channel: CHANNEL, Reason: reason });
    // 503 so the CAD retries; nothing was paged and nothing was trusted.
    return problem(503, 'Service unavailable', traceId);
  };

  let tableName: string;
  let client: ReturnType<typeof createDynamoClient>;
  try {
    ({ tableName } = readAlertingConfig(process.env));
    client = createDynamoClient(process.env);
  } catch (error) {
    return unavailable('ConfigError', error);
  }

  // 1. Source lookup.
  const keyIdHeader = header(event, 'x-boxalarm-source');
  const key = parseSourceKeyId(keyIdHeader);
  if (!key) return reject('UnknownSource');
  let source: Awaited<ReturnType<typeof loadCadSource>>;
  try {
    source = await loadCadSource(client, tableName, key.deptId, key.sourceId);
  } catch (error) {
    return unavailable('SourceLookupUnavailable', error);
  }
  if (!source?.webhook || source.webhook.keyId !== keyIdHeader) {
    return reject('UnknownSource', { keyId: keyIdHeader });
  }

  // 2. Freshness.
  const timestamp = header(event, 'x-boxalarm-timestamp');
  if (!timestamp || !isFreshTimestamp(timestamp, nowSeconds)) {
    return reject('StaleTimestamp', { keyId: keyIdHeader });
  }

  // 3. Signature.
  let keys: string[];
  try {
    keys = await getWebhookKeys(source.webhook.secretName);
  } catch (error) {
    return unavailable('SecretUnavailable', error);
  }
  if (keys.length === 0) return reject('NoActiveKey', { keyId: keyIdHeader });
  const signature = verifySignature(
    keys,
    timestamp,
    rawBody,
    header(event, 'x-boxalarm-signature'),
  );
  if (!signature) return reject('BadSignature', { keyId: keyIdHeader });

  // 4. Replay: an early read-only answer. The marker itself is written inside the dispatch
  // transaction (step 5), so a failed or killed write never strands it (chain review M3).
  const replayRef = { deptId: key.deptId, sourceId: source.sourceId, token: signature };
  try {
    if (await isReplayMarked(client, tableName, replayRef, nowSeconds)) {
      emitCadMetric('CadIngressReplayRejected', { Channel: CHANNEL });
      logInfo('cadIngress.webhook.replay', { traceId, keyId: keyIdHeader });
      return problem(409, 'Conflict', traceId);
    }
  } catch (error) {
    return unavailable('ReplayCacheUnavailable', error);
  }

  // 5. Authenticated: parse (fail open) and write the dispatch with its replay marker.
  const body = readWebhookBody(rawBody.toString('utf8'));
  try {
    const result = await ingestCadDispatch(client, tableName, {
      deptId: key.deptId,
      source,
      channel: CHANNEL,
      text: body.text,
      ...(body.structured ? { structured: body.structured } : {}),
      receivedAt: nowSeconds,
      replay: { token: signature, ttlSeconds: REPLAY_TTL_SECONDS },
    });
    if (result.outcome === 'replay') return problem(409, 'Conflict', traceId);
    if (result.outcome === 'created') {
      return json(202, {
        status: 'accepted',
        dispatchId: result.dispatchId,
        parse: result.parseStatus,
      });
    }
    if (result.outcome === 'updated') {
      return json(202, {
        status: 'updated',
        dispatchId: result.dispatchId,
        updateId: result.updateId,
        parse: result.parseStatus,
      });
    }
    return json(200, { status: 'duplicate' });
  } catch (error) {
    return unavailable('DispatchWriteUnavailable', error);
  }
};
