import { createHash } from 'node:crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import {
  MAX_NARRATIVE_CHARS,
  dispatchTextFingerprint,
  normalizeDispatchText,
  parseCadText,
  parseCadTextBounded,
  resolveCadMessageTime,
  DEFAULT_CAD_TIME_ZONE,
  type CadParseResult,
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
import { notifyUpdate } from './notifyUpdate.js';
import {
  lockedDispatchId,
  recordCadUpdate,
  updateIdFor,
  updateNeedsNotice,
} from './updateRepository.js';
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
  | { readonly outcome: 'replay'; readonly parseStatus: 'PARSED' | 'RAW' }
  | {
      readonly outcome: 'updated';
      readonly dispatchId: string;
      readonly updateId: string;
      readonly parseStatus: 'PARSED' | 'RAW';
    };

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
 * The source's own dispatch identity: the incident number when the CAD sends one (held
 * INCIDENT_IDENTITY_SECONDS; later messages for it are updates); otherwise the text
 * fingerprint, which holds only for TEXT_IDENTITY_SECONDS.
 */
export function cadIdentity(sourceId: string, fields: CadParsedFields, text: string): CadIdentity {
  const incident = fields.incidentNumber?.replace(/\s+/g, ' ').toUpperCase();
  // With an incident number the incident IS the dispatch: a later message for it is an update
  // (updateRepository.ts), whatever its dispatch time says (decision 2026-09-30).
  const identity = incident ? `INC|${incident}` : `TEXT|${dispatchTextFingerprint(text)}`;
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
  /** The template's result, when already run under its deadline (parseCadTextBounded). */
  preParsed?: CadParseResult,
): {
  readonly dispatch: DispatchReceived;
  readonly parseStatus: 'PARSED' | 'RAW';
  readonly parserVersion: number | null;
  readonly fields: CadParsedFields;
  readonly identity: CadIdentity;
} {
  const rawText = normalizeDispatchText(text).trim();
  const structuredResult = structured?.address ? structured : undefined;
  const parsed = structuredResult ? undefined : (preParsed ?? parseCadText(source.parser, rawText));
  // Fields the CAD sent structured win over what the template read from its text (chain m2).
  const fields: CadParsedFields = structuredResult ?? { ...parsed?.fields, ...structured };
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
  // The template runs in a worker under a hard deadline (security review M3); a template that
  // overruns it fails open to RAW - the dispatch still pages - and is counted.
  const preParsed = input.structured?.address
    ? undefined
    : await parseCadTextBounded(source.parser, normalizeDispatchText(input.text).trim());
  if (
    preParsed?.status === 'RAW' &&
    (preParsed.reason === 'TIMEOUT' || preParsed.reason === 'ERROR')
  ) {
    emitCadMetric('CadParseTimeout', { Channel: channel, Reason: preParsed.reason });
    logInfo('cadIngress.parse.deadline', {
      deptId,
      sourceId: source.sourceId,
      reason: preParsed.reason,
    });
  }
  const built = buildCadDispatch(source, input.text, input.structured, preParsed);
  const idempotencyKey = deriveIngressIdempotencyKey(
    deptId,
    'CAD',
    built.dispatch.externalDispatchId,
  );

  const contentHash = dispatchTextFingerprint(normalizeDispatchText(input.text));
  const timeZone = source.timeZone ?? DEFAULT_CAD_TIME_ZONE;
  // The original's time, placed on the day it was received (chain review R3-M1).
  const messageTime = resolveCadMessageTime(built.fields.dispatchTime, {
    receivedAt: input.receivedAt,
    timeZone,
  });
  const replayMarker = input.replay
    ? replayMarkerItem(
        { deptId, sourceId: source.sourceId, token: input.replay.token },
        input.receivedAt,
        input.replay.ttlSeconds,
      )
    : undefined;

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
      contentHash,
      ...(messageTime !== undefined ? { messageTime } : {}),
      ...(built.fields.incidentNumber ? { incidentNumber: built.fields.incidentNumber } : {}),
      ...(built.fields.dispatchTime ? { dispatchTimeText: built.fields.dispatchTime } : {}),
    },
    ...(replayMarker ? { replayMarker } : {}),
  });

  // A later message for an incident already paged: an update, never silent and never a
  // second page (decision 2026-09-30-cad-dispatch-updates.md).
  if (result.outcome === 'duplicate' && built.identity.kind === 'incident') {
    const dispatchId = await lockedDispatchId(
      client,
      tableName,
      deptId,
      built.dispatch.externalDispatchId,
      input.receivedAt,
    );
    const update = dispatchId
      ? await recordCadUpdate(client, tableName, {
          deptId,
          dispatchId,
          dispatch: built.dispatch,
          parseStatus: built.parseStatus,
          contentHash,
          channel,
          receivedAt: input.receivedAt,
          timeZone,
          ...(built.fields.dispatchTime ? { messageTimeText: built.fields.dispatchTime } : {}),
          ...(replayMarker ? { replayMarker } : {}),
        })
      : ({ outcome: 'missing' } as const);
    if (update.outcome === 'recorded' && dispatchId) {
      await notifyUpdate({ deptId, dispatchId, updateId: update.updateId });
      emitCadMetric('CadIngressUpdated', { Channel: channel });
      logInfo('cadIngress.updated', {
        deptId,
        sourceId: source.sourceId,
        channel,
        dispatchId,
        updateId: update.updateId,
        changedFields: update.changes.map((c) => c.field),
      });
      return {
        outcome: 'updated',
        dispatchId,
        updateId: update.updateId,
        parseStatus: built.parseStatus,
      };
    }
    if (update.outcome === 'history' && dispatchId) {
      emitCadMetric('CadIngressOlderMessage', { Channel: channel });
      logInfo('cadIngress.olderMessage', {
        deptId,
        sourceId: source.sourceId,
        channel,
        dispatchId,
        updateId: update.updateId,
      });
      return { outcome: 'duplicate', parseStatus: built.parseStatus };
    }
    if ((update.outcome === 'duplicate' || update.outcome === 'replay') && dispatchId) {
      // The sender's retry of an update whose push hand-off was lost (the Lambda died after
      // commit): the update is recorded but never notified - hand it off again.
      const updateId = updateIdFor(contentHash);
      if (await updateNeedsNotice(client, tableName, deptId, dispatchId, updateId)) {
        emitCadMetric('CadUpdateNoticeRedriven', { Channel: channel });
        await notifyUpdate({ deptId, dispatchId, updateId });
      }
    }
    if (update.outcome === 'replay') {
      emitCadMetric('CadIngressReplayRejected', { Channel: channel });
      return { outcome: 'replay', parseStatus: built.parseStatus };
    }
    if (update.outcome === 'missing') {
      // The lock expired between the write and the read, or points at nothing: never drop a
      // message as a duplicate of a dispatch that does not exist. Loud, and the caller retries.
      throw new Error('CAD incident lock points at no live dispatch; retry');
    }
  }

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
