import { assertNoDelimiter, type VerifiedDeptId } from '@boxalarm/dept-scope';

export type ChannelName = 'push' | 'sms' | 'voice';

export interface ChannelEnvelopePayload {
  readonly deptId: string;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly channel: ChannelName;
  readonly toneSequence: number;
  readonly incidentType: string;
  readonly address: string;
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
    address: textOrFallback(dispatch.address, ADDRESS_FALLBACK),
    isTest: dispatch.isTest,
    crossStreets: dispatch.crossStreets,
    narrative: dispatch.narrative,
    mapLink: dispatch.mapLink,
    sourceSystem: dispatch.sourceSystem,
    ...(input.reason ? { reason: input.reason } : {}),
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
  return { deptId, dispatchId, memberId, channel, toneSequence, incidentType, address };
}

export function noTargetReason(channel: ChannelName): string {
  return `${channel}: no target registered`;
}

export interface ContactChannelSnapshot {
  readonly channel: string;
  readonly valid?: boolean;
  readonly token?: string;
  readonly phoneNumber?: string;
}

export type ResolveChannelTargetResult =
  | { readonly skipped: true; readonly reason: string }
  | { readonly skipped: false; readonly target: string };

const CONTACT_CHANNEL_KEY: Record<ChannelName, string> = {
  push: 'PUSH',
  sms: 'SMS',
  voice: 'VOICE',
};

export function resolveChannelTarget(
  channel: ChannelName,
  contactChannels: readonly ContactChannelSnapshot[] | undefined,
): ResolveChannelTargetResult {
  const entry = (contactChannels ?? []).find(
    (candidate) => candidate.channel === CONTACT_CHANNEL_KEY[channel] && candidate.valid !== false,
  );
  const target = channel === 'push' ? entry?.token : entry?.phoneNumber;
  if (!target) {
    return { skipped: true, reason: noTargetReason(channel) };
  }
  return { skipped: false, target };
}
