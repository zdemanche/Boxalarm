import { createHash } from 'node:crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import {
  MAX_NARRATIVE_CHARS,
  dispatchTextFingerprint,
  normalizeDispatchText,
  parseCadText,
  type CadParsedFields,
} from '@boxalarm/cad-parser';
import {
  cadLocality,
  deriveIngressIdempotencyKey,
  type DispatchReceived,
} from '../dispatches/dispatchIngressPort.js';
import { createManualDispatch } from '../dispatches/repository.js';
import { logInfo } from '../dispatches/logger.js';
import { emitCadMetric, type CadChannel } from './metrics.js';
import { replayMarkerItem } from './replayGuard.js';
import type { CadSourceCopy } from './sourceCopy.js';

/**
 * The single CAD ingestion core. Both ingress paths (emailHandler.ts, webhookHandler.ts) call
 * this ONLY after the sender is authenticated, and it writes the SAME DISPATCH_ALERT
 * transaction the manual path writes (createManualDispatch: idempotency lock, alert, bridge
 * outbox row). It never fans out: the table stream's fan-out is the single tone-1 producer
 * (design review C1), so a CAD page and a manual page are the same page from there on.
 *
 * Parsing fails OPEN (roadmap-defaults row 3): text the source's template cannot structure
 * still pages, with the raw text as the narrative, the address "SEE DISPATCH TEXT" and
 * verifyRequired set.
 */

export const RAW_ADDRESS = 'SEE DISPATCH TEXT';
export const RAW_INCIDENT_TYPE = 'CAD DISPATCH - VERIFY';
const DEFAULT_INCIDENT_TYPE = 'CAD DISPATCH';

export interface CadIngestInput {
  /** From the authenticated source's configuration, never from the message. */
  readonly deptId: VerifiedDeptId;
  readonly source: CadSourceCopy;
  readonly channel: CadChannel;
  /** The dispatch text as received (email body, or webhook body/text). */
  readonly text: string;
  /** Webhook only: fields the CAD sent already structured (they win over the template). */
  readonly structured?: CadParsedFields;
  /** Epoch seconds. */
  readonly receivedAt: number;
  /** The authenticated message's replay marker, written in the same transaction. */
  readonly replay?: { readonly token: string; readonly ttlSeconds: number };
}

export type CadIngestResult =
  | {
      readonly outcome: 'created';
      readonly dispatchId: string;
      readonly parseStatus: 'PARSED' | 'RAW';
    }
  | { readonly outcome: 'duplicate'; readonly parseStatus: 'PARSED' | 'RAW' }
  | { readonly outcome: 'replay'; readonly parseStatus: 'PARSED' | 'RAW' };

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * How long a TEXT-ONLY identity (no incident number) holds: a resend of identical text inside
 * this window is a duplicate, the same text after it is a new call (chain review C1 - a repeat
 * medical call at the same address, days later, must page). Incident-number identities carry
 * their own window (INCIDENT_IDENTITY_SECONDS).
 */
export const TEXT_IDENTITY_SECONDS = 10 * 60;
export const INCIDENT_IDENTITY_SECONDS = 24 * 60 * 60;

export interface CadIdentity {
  /** Hashed so the key never carries '#'. */
  readonly externalDispatchId: string;
  readonly kind: 'incident' | 'text';
  /** Seconds the identity holds from the message's receipt. */
  readonly windowSeconds: number;
}

/**
 * The source's own dispatch identity: incident number + dispatch time when the CAD sends an
 * incident number (the fingerprint stands in for a missing time); otherwise the text
 * fingerprint, which holds only for TEXT_IDENTITY_SECONDS.
 */
export function cadIdentity(sourceId: string, fields: CadParsedFields, text: string): CadIdentity {
  const incident = fields.incidentNumber?.toUpperCase();
  const time = fields.dispatchTime?.replace(/\s+/g, ' ').toUpperCase();
  const identity = incident
    ? `INC|${incident}|${time ?? `TEXT|${dispatchTextFingerprint(text)}`}`
    : `TEXT|${dispatchTextFingerprint(text)}`;
  return {
    externalDispatchId: `${sourceId}.${sha256(identity).slice(0, 40)}`,
    kind: incident ? 'incident' : 'text',
    windowSeconds: incident ? INCIDENT_IDENTITY_SECONDS : TEXT_IDENTITY_SECONDS,
  };
}

/** The identity key alone (see cadIdentity). */
export function cadExternalDispatchId(
  sourceId: string,
  fields: CadParsedFields,
  text: string,
): string {
  return cadIdentity(sourceId, fields, text).externalDispatchId;
}

/** "123 MAIN ST, NICHOLS" -> "NICHOLS": the town when the template has no town field. */
function townFromAddress(address: string): string | undefined {
  const comma = address.lastIndexOf(',');
  return comma > 0 ? address.slice(comma + 1) : undefined;
}

function splitUnits(units: string | undefined): string[] {
  return units ? units.split(/[\s,;/]+/).filter((unit) => unit.length > 0) : [];
}

export function buildCadDispatch(
  source: CadSourceCopy,
  text: string,
  structured: CadParsedFields | undefined,
): {
  readonly dispatch: DispatchReceived;
  readonly parseStatus: 'PARSED' | 'RAW';
  readonly parserVersion: number | null;
  readonly fields: CadParsedFields;
  readonly identity: CadIdentity;
} {
  const rawText = normalizeDispatchText(text).trim();
  const structuredResult = structured?.address ? structured : undefined;
  const parsed = structuredResult ? undefined : parseCadText(source.parser, rawText);
  const fields: CadParsedFields = structuredResult ?? { ...structured, ...parsed?.fields };
  const isParsed = structuredResult !== undefined || parsed?.status === 'PARSED';
  const narrativeFallback = rawText.slice(0, MAX_NARRATIVE_CHARS);
  const identity = cadIdentity(source.sourceId, fields, rawText);
  const { externalDispatchId } = identity;

  if (isParsed && fields.address) {
    const locality = cadLocality(fields.town ?? townFromAddress(fields.address));
    return {
      parseStatus: 'PARSED',
      identity,
      parserVersion: structuredResult ? null : (parsed?.version ?? null),
      fields,
      dispatch: {
        sourceSystem: 'CAD',
        incidentType: fields.incidentType ?? DEFAULT_INCIDENT_TYPE,
        address: fields.address,
        crossStreets: fields.crossStreets ?? '',
        unitsRequested: splitUnits(fields.units),
        narrative: fields.narrative ?? narrativeFallback,
        externalDispatchId,
        ...(locality ? { locality } : {}),
      },
    };
  }
  // Fail open: the whole text is the narrative. Nothing the template half-read is shown as
  // the address; the crew reads the dispatch text.
  return {
    parseStatus: 'RAW',
    identity,
    parserVersion: parsed?.version ?? null,
    fields,
    dispatch: {
      sourceSystem: 'CAD',
      incidentType: RAW_INCIDENT_TYPE,
      address: RAW_ADDRESS,
      crossStreets: '',
      unitsRequested: splitUnits(fields.units),
      narrative: narrativeFallback.length > 0 ? narrativeFallback : '(empty dispatch text)',
      externalDispatchId,
    },
  };
}

export async function ingestCadDispatch(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: CadIngestInput,
): Promise<CadIngestResult> {
  const { deptId, source, channel } = input;
  const built = buildCadDispatch(source, input.text, input.structured);
  const idempotencyKey = deriveIngressIdempotencyKey(
    deptId,
    'CAD',
    built.dispatch.externalDispatchId,
  );

  const result = await createManualDispatch(client, tableName, {
    deptId,
    dispatch: built.dispatch,
    idempotencyKey,
    dispatchedAt: input.receivedAt,
    lockExpiresAt: input.receivedAt + built.identity.windowSeconds,
    cad: {
      ingressChannel: channel,
      sourceId: source.sourceId,
      parseStatus: built.parseStatus,
      parserVersion: built.parserVersion,
      verifyRequired: built.parseStatus === 'RAW',
      ...(built.fields.incidentNumber ? { incidentNumber: built.fields.incidentNumber } : {}),
      ...(built.fields.dispatchTime ? { dispatchTimeText: built.fields.dispatchTime } : {}),
    },
    ...(input.replay
      ? {
          replayMarker: replayMarkerItem(
            { deptId, sourceId: source.sourceId, token: input.replay.token },
            input.receivedAt,
            input.replay.ttlSeconds,
          ),
        }
      : {}),
  });

  if (result.outcome === 'replay') {
    emitCadMetric('CadIngressReplayRejected', { Channel: channel });
    logInfo('cadIngress.replay', { deptId, sourceId: source.sourceId, channel });
    return { outcome: 'replay', parseStatus: built.parseStatus };
  }

  if (result.outcome === 'duplicate') {
    emitCadMetric('CadIngressDuplicate', { Channel: channel, Identity: built.identity.kind });
    logInfo('cadIngress.duplicate', {
      deptId,
      sourceId: source.sourceId,
      channel,
      identity: built.identity.kind,
    });
    return { outcome: 'duplicate', parseStatus: built.parseStatus };
  }
  emitCadMetric('CadIngressAccepted', { Channel: channel });
  emitCadMetric('CadIngressParsed', { Channel: channel, Outcome: built.parseStatus });
  if (built.parseStatus === 'RAW') {
    // Alarmed on its own (the dimensionless set): the template needs attention, the page went.
    emitCadMetric('CadIngressRawFallback', { Channel: channel });
  }
  logInfo('cadIngress.accepted', {
    deptId,
    sourceId: source.sourceId,
    channel,
    dispatchId: result.dispatchId,
    parseStatus: built.parseStatus,
    parserVersion: built.parserVersion,
  });
  return { outcome: 'created', dispatchId: result.dispatchId, parseStatus: built.parseStatus };
}
