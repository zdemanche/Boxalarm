import type { DispatchAuditEntry } from './queryAuditLog.js';

const TONE_SEQUENCE_ONE = 1;

export interface MemberDeliveryStat {
  readonly memberId: string;
  readonly sent: number;
  readonly delivered: number;
  readonly missedPageCount: number;
}

export interface DeliveryBaselineMetrics {
  readonly dispatchCount: number;
  readonly sentCount: number;
  readonly deliveredCount: number;
  readonly deliveryRate: number;
  readonly missedPageCount: number;
  readonly timeToFirstAckAverageSeconds: number | null;
  readonly timeToFirstAckMedianSeconds: number | null;
  readonly perMember: readonly MemberDeliveryStat[];
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function computeDeliveryBaseline(
  entries: readonly DispatchAuditEntry[],
): DeliveryBaselineMetrics {
  let sentCount = 0;
  let deliveredCount = 0;
  let missedPageCount = 0;
  const ackSeconds: number[] = [];
  const memberStats = new Map<string, { sent: number; delivered: number; missed: number }>();

  for (const entry of entries) {
    const dispatchedAt = entry.dispatch.dispatchedAt as number | undefined;
    const receipts = entry.timeline.filter(
      (item) => item.entityType === 'DELIVERY_RECEIPT' && item.toneSequence === TONE_SEQUENCE_ONE,
    );
    const responses = entry.timeline.filter(
      (item) => item.entityType === 'DISPATCH_RESPONSE_RECORD',
    );
    const respondedMemberIds = new Set(receipts.map((receipt) => receipt.memberId as string));

    for (const receipt of receipts) {
      const memberId = receipt.memberId as string;
      const stat = memberStats.get(memberId) ?? { sent: 0, delivered: 0, missed: 0 };
      stat.sent += 1;
      sentCount += 1;
      if (receipt.deliveredAt !== undefined) {
        stat.delivered += 1;
        deliveredCount += 1;
      }
      memberStats.set(memberId, stat);
    }

    for (const memberId of respondedMemberIds) {
      const memberResponses = responses.filter((response) => response.memberId === memberId);
      const stat = memberStats.get(memberId) ?? { sent: 0, delivered: 0, missed: 0 };
      if (memberResponses.length === 0) {
        stat.missed += 1;
        missedPageCount += 1;
      } else if (typeof dispatchedAt === 'number') {
        const firstAckAt = Math.min(
          ...memberResponses.map((response) => response.answeredAt as number),
        );
        ackSeconds.push(firstAckAt - dispatchedAt);
      }
      memberStats.set(memberId, stat);
    }
  }

  return {
    dispatchCount: entries.length,
    sentCount,
    deliveredCount,
    deliveryRate: sentCount === 0 ? 0 : deliveredCount / sentCount,
    missedPageCount,
    timeToFirstAckAverageSeconds:
      ackSeconds.length === 0
        ? null
        : ackSeconds.reduce((sum, seconds) => sum + seconds, 0) / ackSeconds.length,
    timeToFirstAckMedianSeconds: median(ackSeconds),
    perMember: [...memberStats.entries()].map(([memberId, stat]) => ({
      memberId,
      sent: stat.sent,
      delivered: stat.delivered,
      missedPageCount: stat.missed,
    })),
  };
}
