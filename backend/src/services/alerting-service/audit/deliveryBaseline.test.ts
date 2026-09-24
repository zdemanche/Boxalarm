import { describe, expect, it } from 'vitest';
import { computeDeliveryBaseline } from './deliveryBaseline.js';
import type { DispatchAuditEntry } from './queryAuditLog.js';

const ENTRY: DispatchAuditEntry = {
  dispatchId: 'd-1',
  dispatch: { dispatchedAt: 1000 },
  timeline: [
    { entityType: 'DELIVERY_RECEIPT', memberId: 'mbr-1', toneSequence: 1, deliveredAt: 1002 },
    { entityType: 'DELIVERY_RECEIPT', memberId: 'mbr-2', toneSequence: 1 },
    { entityType: 'DISPATCH_RESPONSE_RECORD', memberId: 'mbr-1', answeredAt: 1030 },
  ],
};

describe('computeDeliveryBaseline', () => {
  it('computes delivery rate, missed-page count, and time-to-first-ack (E1-S15 AC2)', () => {
    const result = computeDeliveryBaseline([ENTRY]);
    expect(result.dispatchCount).toBe(1);
    expect(result.sentCount).toBe(2);
    expect(result.deliveredCount).toBe(1);
    expect(result.deliveryRate).toBe(0.5);
    expect(result.missedPageCount).toBe(1); // mbr-2 never answered
    expect(result.timeToFirstAckAverageSeconds).toBe(30);
    expect(result.perMember).toEqual(
      expect.arrayContaining([
        { memberId: 'mbr-1', sent: 1, delivered: 1, missedPageCount: 0 },
        { memberId: 'mbr-2', sent: 1, delivered: 0, missedPageCount: 1 },
      ]),
    );
  });

  it('returns nulls/zeros for an empty period rather than dividing by zero', () => {
    const result = computeDeliveryBaseline([]);
    expect(result.deliveryRate).toBe(0);
    expect(result.timeToFirstAckAverageSeconds).toBeNull();
    expect(result.timeToFirstAckMedianSeconds).toBeNull();
  });
});
