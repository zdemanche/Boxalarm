import { describe, expect, it } from 'vitest';
import { computeNerisCompliance, toComplianceIncident } from './compute.js';

const NOW = 1_800_000_000;
const H = 3_600;

describe('computeNerisCompliance', () => {
  it('computes on-time share over calls at least 72 h old, rejection rate, and oldest drafts', () => {
    const result = computeNerisCompliance(
      [
        // on time: NERIS accepted 20 h after the alarm
        {
          incidentId: 'A',
          alarmAt: NOW - 200 * H,
          firstSubmittedAt: NOW - 180 * H,
          nerisIncidentId: 'n-a',
          nerisStatus: 'APPROVED',
        },
        // late: accepted 100 h after the alarm, then rejected
        {
          incidentId: 'B',
          alarmAt: NOW - 150 * H,
          firstSubmittedAt: NOW - 50 * H,
          nerisIncidentId: 'n-b',
          nerisStatus: 'REJECTED',
        },
        // never sent, 96 h old, locked
        {
          incidentId: 'C',
          alarmAt: NOW - 96 * H,
          createdBy: 'MBR-0034',
          status: 'VALIDATED',
          lockedAt: NOW - 90 * H,
        },
        // too young to count toward the 72 h measure, still a draft
        { incidentId: 'D', alarmAt: NOW - 5 * H, createdBy: 'MBR-0099', status: 'DRAFT' },
      ],
      NOW,
      90,
    );
    expect(result).toEqual({
      windowDays: 90,
      submittedWithin72hPct: 33.3,
      rejectionRate: 50,
      submittedCount: 2,
      rejectedCount: 1,
      eligibleCount: 3,
      openDrafts: [
        { id: 'C', ageHours: 96, owner: 'MBR-0034', status: 'VALIDATED', locked: true },
        { id: 'D', ageHours: 5, owner: 'MBR-0099', status: 'DRAFT', locked: false },
      ],
    });
  });

  it('returns null rates rather than 0% or 100% when there is nothing to measure', () => {
    const result = computeNerisCompliance([], NOW, 30);
    expect(result.submittedWithin72hPct).toBeNull();
    expect(result.rejectionRate).toBeNull();
    expect(result.openDrafts).toEqual([]);
  });

  it('maps GSI1 items and skips malformed ones', () => {
    expect(toComplianceIncident({ incidentId: 'A', epochSeconds: 5, createdBy: 'M' })).toEqual({
      incidentId: 'A',
      alarmAt: 5,
      createdBy: 'M',
    });
    expect(toComplianceIncident({ alarmAt: 5 })).toBeUndefined();
  });
});
