import { describe, expect, it } from 'vitest';
import { assembleDashboard } from './assemble.js';

const now = Date.parse('2026-09-25T16:00:00.000Z');

describe('assembleDashboard', () => {
  it('aggregates staffing, out-of-service apparatus, expiring certs, and NERIS submissions', () => {
    const view = assembleDashboard(
      [
        { sk: 'META', updatedAt: now - 60_000 },
        { sk: 'MEMBER#m-1', status: 'ACTIVE', available: true },
        { sk: 'MEMBER#m-2', status: 'ACTIVE', available: false },
        { sk: 'MEMBER#m-3', status: 'INACTIVE', available: false },
        { sk: 'OOS#E1', unitId: 'E1', reason: 'pump', startedAt: now - 3_600_000 },
        { sk: 'CERT#c-1', memberId: 'm-1', certId: 'c-1', expiryDate: '2026-10-01' },
        { sk: 'NERIS#inc-1', incidentId: 'inc-1', status: 'FAILED' },
        { sk: 'NERIS#inc-2', incidentId: 'inc-2', status: 'SUBMITTED' },
        { sk: 'COVERAGE#shift-1', shiftId: 'shift-1', gapReason: 'no officer' },
      ],
      now,
    );
    expect(view.lastUpdated).toBe('2026-09-25T15:59:00.000Z');
    expect(view.staffing.activeMemberCount).toBe(2);
    expect(view.staffing.unavailableCount).toBe(2);
    expect(view.staffing.shiftCoverage.gapCount).toBe(1);
    expect(view.outOfServiceApparatus).toEqual([
      { unitId: 'E1', reason: 'pump', durationSeconds: 3600 },
    ]);
    expect(view.expiringCertifications.count).toBe(1);
    expect(view.nerisCompliance).toMatchObject({
      pendingCount: 1,
      failedCount: 1,
      submissions: [
        { incidentId: 'inc-1', status: 'FAILED', href: '/api/v1/incidents/inc-1' },
        { incidentId: 'inc-2', status: 'PENDING', href: '/api/v1/incidents/inc-2' },
      ],
    });
  });
});
