import { createHash } from 'node:crypto';

export type FanOutChannel = 'push' | 'sms' | 'voice';

export interface FanOutKeyInput {
  readonly dispatchId: string;
  readonly toneSequence: number;
  readonly memberId: string;
  readonly channel: FanOutChannel;
}

export interface FanOutKey {
  readonly sk: string;
  readonly idempotencyKey: string;
}

function keyParts(input: FanOutKeyInput): string {
  return `${input.dispatchId}#${input.toneSequence}#${input.memberId}#${input.channel}`;
}

export function deriveFanOutKey(input: FanOutKeyInput): FanOutKey {
  return {
    sk: `RECEIPT#${input.memberId}#${input.channel}#${input.toneSequence}`,
    idempotencyKey: keyParts(input),
  };
}

export function deriveMessageDeduplicationId(input: FanOutKeyInput): string {
  return createHash('sha256').update(keyParts(input)).digest('hex');
}
