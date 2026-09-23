import { assertNoDelimiter } from '@boxalarm/dept-scope';

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
