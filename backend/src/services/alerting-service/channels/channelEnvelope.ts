import { assertNoDelimiter, type VerifiedDeptId } from '@boxalarm/dept-scope';
import {
  contactPhone,
  findContactEntry,
  resolvePushTargets,
} from '../eligibility/resolvePushTarget.js';

export type ChannelName = 'push' | 'sms' | 'voice';

export interface ChannelEnvelopePayload {
  readonly deptId: string;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly channel: ChannelName;
  readonly toneSequence: number;
  readonly incidentType: string;
  readonly address: string;
  /** Self-test/canary dispatch — fan-out stamps it; anything but `true` is a real page. */
  readonly isTest: boolean;
  /** Optional: the push worker sends them to the app as their own keys (pushPayload.ts). */
  readonly crossStreets?: string | undefined;
  /** DISPATCH_ALERT.dispatchedAt, epoch seconds. */
  readonly dispatchedAt?: number | undefined;
  /** Test pages only: whether FCM really delivers (see TestDelivery). */
  readonly testDelivery?: TestDelivery | undefined;
}

/**
 * How a test page reaches Android: `deliver` (a member's self-test, or the canary on a
 * dedicated device) really rings the phone through production FCM, labelled TEST; `validate`
 * (the default canary) is FCM validate_only - credentials verified, nothing delivered. APNs
 * always delivers on the device's own environment.
 */
export type TestDelivery = 'deliver' | 'validate';

function asTestDelivery(value: unknown): TestDelivery | undefined {
  return value === 'deliver' || value === 'validate' ? value : undefined;
}

export type ChannelTier = 'primary' | 'escalation';

/**
 * The dispatch-record fields a page's text is built from. Every producer sources these from
 * the DISPATCH_ALERT METADATA item (stream image or GetItem), never from a caller.
 */
export interface DispatchAlertText {
  readonly incidentType: string | undefined;
  readonly address: string | undefined;
  readonly isTest: boolean;
  readonly crossStreets?: string | undefined;
  readonly narrative?: string | undefined;
  readonly mapLink?: string | undefined;
  readonly sourceSystem?: string | undefined;
  /** Epoch seconds the dispatch was received. */
  readonly dispatchedAt?: number | undefined;
  readonly testDelivery?: TestDelivery | undefined;
  /**
   * A CAD dispatch its source's template could not structure (fail-open RAW): the address is a
   * placeholder, so the page carries an excerpt of the dispatch text instead (chain review M1).
   */
  readonly verifyRequired?: boolean | undefined;
}

/**
 * How much of a RAW dispatch's text a page carries in place of the address, in UTF-8 bytes:
 * within the push worker's address cap (256 bytes, pushPayload.ts) and two SMS segments with
 * the "{type} — " prefix. The full text is on the alert screen.
 */
export const RAW_PAGE_EXCERPT_MAX_BYTES = 240;

function utf8Excerpt(text: string, maxBytes: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (Buffer.byteLength(collapsed) <= maxBytes) return collapsed;
  let bytes = 0;
  let out = '';
  for (const char of collapsed) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes - 3) return `${out}…`;
    bytes += size;
    out += char;
  }
  return out;
}

/**
 * The location line a page carries: the address, or - for a RAW (VERIFY) CAD dispatch whose
 * address is only the "SEE DISPATCH TEXT" placeholder - "VERIFY: " and an excerpt of the
 * dispatch text, so push, SMS and voice all carry what the CAD actually said.
 */
export function pageLocationText(dispatch: DispatchAlertText): string {
  if (dispatch.verifyRequired === true && dispatch.narrative && dispatch.narrative.trim()) {
    return `VERIFY: ${utf8Excerpt(dispatch.narrative, RAW_PAGE_EXCERPT_MAX_BYTES)}`;
  }
  return textOrFallback(dispatch.address, ADDRESS_FALLBACK);
}

// Ingress rejects a dispatch without incidentType/address, so these only fire on a corrupt or
// legacy record. Paging with placeholder text beats a parser rejection that DLQs the page (or,
// on the fan-out stream, wedges the shard behind a record that can never succeed).
export const INCIDENT_TYPE_FALLBACK = 'DISPATCH';
export const ADDRESS_FALLBACK = 'ADDRESS UNAVAILABLE - CHECK CAD/RADIO';

function textOrFallback(value: string | undefined, fallback: string): string {
  return value && value.trim().length > 0 ? value : fallback;
}

export function readDispatchAlertText(item: Record<string, unknown>): DispatchAlertText {
  const optional = (key: string): string | undefined =>
    typeof item[key] === 'string' ? item[key] : undefined;
  return {
    incidentType: optional('incidentType'),
    address: optional('address'),
    isTest: item.isTest === true,
    crossStreets: optional('crossStreets'),
    narrative: optional('narrative'),
    mapLink: optional('mapLink'),
    sourceSystem: optional('sourceSystem'),
    dispatchedAt: typeof item.dispatchedAt === 'number' ? item.dispatchedAt : undefined,
    testDelivery: asTestDelivery(item.testDelivery),
    verifyRequired: item.verifyRequired === true,
  };
}

/**
 * The producer half of the channel-worker contract. Every publisher to the alerting topic
 * builds its payload here, so the compiler — not a hand-rolled object literal per call site —
 * guarantees each page carries every field parseChannelEnvelope requires.
 */
export interface ChannelPagePayload extends ChannelEnvelopePayload {
  readonly alertKind: 'dispatch';
  readonly channelTier: ChannelTier;
  readonly isTest: boolean;
  readonly crossStreets?: string | undefined;
  readonly narrative?: string | undefined;
  readonly mapLink?: string | undefined;
  readonly sourceSystem?: string | undefined;
  readonly dispatchedAt?: number | undefined;
  readonly reason?: string | undefined;
}

export interface ChannelPageInput {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly channel: ChannelName;
  readonly channelTier: ChannelTier;
  readonly toneSequence: number;
  readonly dispatch: DispatchAlertText;
  readonly reason?: string;
}

export function buildChannelPagePayload(input: ChannelPageInput): ChannelPagePayload {
  const { dispatch } = input;
  return {
    alertKind: 'dispatch',
    deptId: input.deptId,
    dispatchId: input.dispatchId,
    memberId: input.memberId,
    channel: input.channel,
    channelTier: input.channelTier,
    toneSequence: input.toneSequence,
    incidentType: textOrFallback(dispatch.incidentType, INCIDENT_TYPE_FALLBACK),
    address: pageLocationText(dispatch),
    isTest: dispatch.isTest,
    crossStreets: dispatch.crossStreets,
    narrative: dispatch.narrative,
    mapLink: dispatch.mapLink,
    sourceSystem: dispatch.sourceSystem,
    dispatchedAt: dispatch.dispatchedAt,
    ...(dispatch.isTest && dispatch.testDelivery ? { testDelivery: dispatch.testDelivery } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

/** The optional alert fields a page may carry, kept only when well-typed. */
function optionalAlertFields(
  payload: Record<string, unknown> | undefined,
): Pick<ChannelEnvelopePayload, 'crossStreets' | 'dispatchedAt' | 'testDelivery'> {
  const crossStreets = payload?.crossStreets;
  const dispatchedAt = payload?.dispatchedAt;
  const testDelivery = asTestDelivery(payload?.testDelivery);
  return {
    ...(testDelivery ? { testDelivery } : {}),
    ...(typeof crossStreets === 'string' && crossStreets.trim().length > 0 ? { crossStreets } : {}),
    ...(typeof dispatchedAt === 'number' && Number.isFinite(dispatchedAt) ? { dispatchedAt } : {}),
  };
}

export function parseChannelEnvelope(
  body: string,
  expectedChannel: ChannelName,
): ChannelEnvelopePayload {
  const raw = JSON.parse(body) as Record<string, unknown>;
  const payload = raw.payload as Record<string, unknown> | undefined;
  const deptId = payload?.deptId;
  const dispatchId = payload?.dispatchId;
  const memberId = payload?.memberId;
  const channel = payload?.channel;
  const toneSequence = payload?.toneSequence;
  const incidentType = payload?.incidentType;
  const address = payload?.address;
  if (
    typeof deptId !== 'string' ||
    typeof dispatchId !== 'string' ||
    typeof memberId !== 'string' ||
    (channel !== 'push' && channel !== 'sms' && channel !== 'voice') ||
    typeof toneSequence !== 'number' ||
    !Number.isFinite(toneSequence) ||
    typeof incidentType !== 'string' ||
    typeof address !== 'string'
  ) {
    throw new Error('alerting channel envelope failed shape validation');
  }
  if (channel !== expectedChannel) {
    throw new Error(
      `channel envelope routed to the ${expectedChannel} worker carries channel=${channel}`,
    );
  }
  assertNoDelimiter(dispatchId, 'dispatchId');
  assertNoDelimiter(memberId, 'memberId');
  const isTest = payload?.isTest === true;
  return {
    deptId,
    dispatchId,
    memberId,
    channel,
    toneSequence,
    incidentType,
    address,
    isTest,
    ...optionalAlertFields(payload),
  };
}

/**
 * Officer mutual-aid prompt (F1.13): rides the push queue with `alertKind: 'mutual_aid_prompt'`
 * and deliberately no toneSequence — the push worker branches on alertKind and guards it in its
 * own namespace rather than a per-tone RECEIPT# key an officer toned at tone 3 already holds.
 */
export interface MutualAidPromptPayload {
  readonly alertKind: 'mutual_aid_prompt';
  readonly deptId: string;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly channel: 'push';
  readonly incidentType: string;
  readonly address: string;
  /** Self-test/canary prompt — the push worker sends it with the sandbox credentials. */
  readonly isTest: boolean;
  readonly crossStreets?: string | undefined;
  readonly dispatchedAt?: number | undefined;
  readonly testDelivery?: TestDelivery | undefined;
}

export type MutualAidPromptPagePayload = MutualAidPromptPayload;

export interface MutualAidPromptInput {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly dispatch: DispatchAlertText;
}

export function buildMutualAidPromptPayload(
  input: MutualAidPromptInput,
): MutualAidPromptPagePayload {
  return {
    alertKind: 'mutual_aid_prompt',
    deptId: input.deptId,
    dispatchId: input.dispatchId,
    memberId: input.memberId,
    channel: 'push',
    incidentType: textOrFallback(input.dispatch.incidentType, INCIDENT_TYPE_FALLBACK),
    address: pageLocationText(input.dispatch),
    isTest: input.dispatch.isTest,
    ...(input.dispatch.crossStreets ? { crossStreets: input.dispatch.crossStreets } : {}),
    ...(input.dispatch.dispatchedAt !== undefined
      ? { dispatchedAt: input.dispatch.dispatchedAt }
      : {}),
  };
}

/**
 * Returns undefined when the body is not a mutual-aid prompt (the caller then parses it as a
 * dispatch page); throws when it claims to be one but is malformed or misrouted.
 */
export function parseMutualAidPromptEnvelope(
  body: string,
  expectedChannel: ChannelName,
): MutualAidPromptPayload | undefined {
  const raw = JSON.parse(body) as Record<string, unknown>;
  const payload = raw.payload as Record<string, unknown> | undefined;
  if (payload?.alertKind !== 'mutual_aid_prompt') {
    return undefined;
  }
  const { deptId, dispatchId, memberId, channel, incidentType, address } = payload;
  if (
    typeof deptId !== 'string' ||
    typeof dispatchId !== 'string' ||
    typeof memberId !== 'string' ||
    channel !== 'push' ||
    typeof incidentType !== 'string' ||
    typeof address !== 'string'
  ) {
    throw new Error('mutual-aid prompt envelope failed shape validation');
  }
  if (channel !== expectedChannel) {
    throw new Error(
      `mutual-aid prompt routed to the ${expectedChannel} worker carries channel=${channel}`,
    );
  }
  assertNoDelimiter(dispatchId, 'dispatchId');
  assertNoDelimiter(memberId, 'memberId');
  return {
    alertKind: 'mutual_aid_prompt',
    deptId,
    dispatchId,
    memberId,
    channel,
    incidentType,
    address,
    isTest: payload.isTest === true,
    ...optionalAlertFields(payload),
  };
}

/**
 * A CAD update to a call already paged (docs/decisions/2026-09-30-cad-dispatch-updates.md):
 * a non-escalating push to members already on the dispatch's roster. No toneSequence, no tone
 * ladder; guarded per update in its own CADUPDATE# namespace so it never collides with a
 * tone's RECEIPT#.
 */
export interface CadUpdatePayload {
  readonly alertKind: 'dispatch_update';
  readonly deptId: string;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly channel: 'push';
  /** Deterministic per update content (cadIngress/updateRepository.ts). */
  readonly updateId: string;
  readonly incidentType: string;
  readonly address: string;
  /** Short "what changed" line, e.g. "Units: E1, L2 -> E1, L2, R1". */
  readonly summary: string;
  readonly isTest: false;
  readonly crossStreets?: string | undefined;
  readonly dispatchedAt?: number | undefined;
  readonly testDelivery?: undefined;
}

export function buildCadUpdatePayload(input: {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly updateId: string;
  readonly summary: string;
  readonly dispatch: DispatchAlertText;
}): CadUpdatePayload {
  return {
    alertKind: 'dispatch_update',
    deptId: input.deptId,
    dispatchId: input.dispatchId,
    memberId: input.memberId,
    channel: 'push',
    updateId: input.updateId,
    incidentType: textOrFallback(input.dispatch.incidentType, INCIDENT_TYPE_FALLBACK),
    address: pageLocationText(input.dispatch),
    summary: input.summary,
    isTest: false,
    ...(input.dispatch.crossStreets ? { crossStreets: input.dispatch.crossStreets } : {}),
    ...(input.dispatch.dispatchedAt !== undefined
      ? { dispatchedAt: input.dispatch.dispatchedAt }
      : {}),
  };
}

const UPDATE_ID = /^[0-9a-f]{16,64}$/;

/** Undefined when the body is not a CAD update; throws when it claims to be one but is bad. */
export function parseCadUpdateEnvelope(
  body: string,
  expectedChannel: ChannelName,
): CadUpdatePayload | undefined {
  const raw = JSON.parse(body) as Record<string, unknown>;
  const payload = raw.payload as Record<string, unknown> | undefined;
  if (payload?.alertKind !== 'dispatch_update') {
    return undefined;
  }
  const { deptId, dispatchId, memberId, channel, updateId, incidentType, address, summary } =
    payload;
  if (
    typeof deptId !== 'string' ||
    typeof dispatchId !== 'string' ||
    typeof memberId !== 'string' ||
    channel !== 'push' ||
    typeof updateId !== 'string' ||
    !UPDATE_ID.test(updateId) ||
    typeof incidentType !== 'string' ||
    typeof address !== 'string' ||
    typeof summary !== 'string'
  ) {
    throw new Error('CAD update envelope failed shape validation');
  }
  if (channel !== expectedChannel) {
    throw new Error(
      `CAD update routed to the ${expectedChannel} worker carries channel=${channel}`,
    );
  }
  assertNoDelimiter(dispatchId, 'dispatchId');
  assertNoDelimiter(memberId, 'memberId');
  const optional = optionalAlertFields(payload);
  return {
    alertKind: 'dispatch_update',
    deptId,
    dispatchId,
    memberId,
    channel,
    updateId,
    incidentType,
    address,
    summary,
    isTest: false,
    ...(optional.crossStreets ? { crossStreets: optional.crossStreets } : {}),
    ...(optional.dispatchedAt !== undefined ? { dispatchedAt: optional.dispatchedAt } : {}),
  };
}

export function noTargetReason(channel: ChannelName): string {
  return `${channel}: no target registered`;
}

export interface ContactChannelSnapshot {
  readonly channel: string;
  readonly valid?: boolean;
  /** PUSH only: `APNS` or `FCM`, as registerToken.ts writes it — picks the push gateway. */
  readonly platform?: string;
  readonly token?: string;
  readonly phoneNumber?: string;
  /** PUSH only: the registering app installation; one PUSH entry per device. */
  readonly deviceId?: string;
  /** PUSH, iOS only: the token's APNs environment (`development` | `production`, default). */
  readonly apnsEnvironment?: string;
}

export type ResolveChannelTargetResult =
  | { readonly skipped: true; readonly reason: string }
  | { readonly skipped: false; readonly target: string };

/**
 * Resolves the worker's send target from the eligibility snapshot's contact channels. The
 * producers (fanout/handler.ts, toneEvaluatorHandler.ts via eligibility/resolvePushTarget.ts)
 * decide which channels to publish from the same snapshot with the same findContactEntry,
 * so both sides accept the same shapes - a mismatch means the producer publishes and the worker silently finds no
 * target (the recurring SMS-never-sends defect, #12). Accepted, case-insensitively:
 *  - push: a PUSH entry's token (registerToken.ts) - here the first device; the push worker
 *    sends to every device (resolvePushTargets);
 *  - sms: an SMS entry's phone, as phoneNumber (eligibility/contactProjection.ts projects the
 *    member's phone into { channel: 'SMS', phoneNumber }) or the legacy `token`;
 *  - voice: a VOICE entry's phone (projected from the same phone), else the SMS phone.
 */
export function resolveChannelTarget(
  channel: ChannelName,
  contactChannels: readonly ContactChannelSnapshot[] | undefined,
): ResolveChannelTargetResult {
  const target =
    channel === 'push'
      ? resolvePushTargets(contactChannels)[0]?.token
      : channel === 'sms'
        ? contactPhone(findContactEntry(contactChannels, 'SMS'))
        : (contactPhone(findContactEntry(contactChannels, 'VOICE')) ??
          contactPhone(findContactEntry(contactChannels, 'SMS')));
  if (!target) {
    return { skipped: true, reason: noTargetReason(channel) };
  }
  return { skipped: false, target };
}
