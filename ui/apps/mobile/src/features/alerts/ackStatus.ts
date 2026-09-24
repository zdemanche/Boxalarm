import type { PaletteColors } from '@boxalarm/design-tokens';
import type { AckStatus } from './types';

export function ackStatusColor(status: AckStatus, tokens: PaletteColors): string {
  if (status === 'RESPONDING' || status === 'DIRECT_TO_SCENE') return tokens.success;
  if (status === 'NOT_RESPONDING') return tokens.error;
  return tokens.foreground;
}

const LABEL: Record<AckStatus, string> = {
  RESPONDING: 'Responding',
  NOT_RESPONDING: 'Not responding',
  DIRECT_TO_SCENE: 'Direct to scene',
  UNANSWERED: 'Awaiting response',
};

export function ackStatusLabel(status: AckStatus): string {
  return LABEL[status];
}
