export interface DashboardGap {
  readonly shiftId: string;
  readonly gapReason: string;
}

export interface DashboardOos {
  readonly unitId: string;
  readonly reason: string;
  readonly durationSeconds: number | null;
}

export interface DashboardCert {
  readonly memberId: string;
  readonly certId: string;
  readonly expiryDate: string;
}

export interface DashboardNerisSubmission {
  readonly incidentId: string;
  readonly status: 'PENDING' | 'FAILED';
  readonly href: string;
}

export interface DashboardView {
  readonly lastUpdated: string | null;
  readonly staffing: {
    readonly activeMemberCount: number;
    readonly unavailableCount: number;
    readonly shiftCoverage: {
      readonly gapCount: number;
      readonly gaps: readonly DashboardGap[];
    };
  };
  readonly outOfServiceApparatus: readonly DashboardOos[];
  readonly expiringCertifications: {
    readonly count: number;
    readonly certifications: readonly DashboardCert[];
  };
  readonly nerisCompliance: {
    readonly pendingCount: number;
    readonly failedCount: number;
    readonly submissions: readonly DashboardNerisSubmission[];
  };
}

function text(item: Record<string, unknown>, key: string): string {
  const value = item[key];
  return typeof value === 'string' ? value : '';
}

function epochMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value);
}

function nerisStatus(raw: string): 'PENDING' | 'FAILED' | undefined {
  if (raw === 'FAILED' || raw === 'REJECTED') {
    return 'FAILED';
  }
  if (raw === 'PENDING' || raw === 'SUBMITTED') {
    return 'PENDING';
  }
  return undefined;
}

export function assembleDashboard(
  items: readonly Record<string, unknown>[],
  nowMs: number,
): DashboardView {
  let activeMemberCount = 0;
  let unavailableCount = 0;
  let lastUpdated: string | null = null;
  const gaps: DashboardGap[] = [];
  const outOfServiceApparatus: DashboardOos[] = [];
  const certifications: DashboardCert[] = [];
  const submissions: DashboardNerisSubmission[] = [];

  for (const item of items) {
    const sk = text(item, 'sk');
    if (sk === 'META') {
      const updatedAt = epochMs(item.updatedAt);
      lastUpdated = updatedAt === undefined ? null : new Date(updatedAt).toISOString();
      continue;
    }
    if (sk.startsWith('MEMBER#')) {
      if (item.status === 'ACTIVE') {
        activeMemberCount += 1;
      }
      if (item.available === false) {
        unavailableCount += 1;
      }
      continue;
    }
    if (sk.startsWith('OOS#')) {
      const startedAt = epochMs(item.startedAt);
      outOfServiceApparatus.push({
        unitId: text(item, 'unitId'),
        reason: text(item, 'reason'),
        durationSeconds:
          startedAt === undefined ? null : Math.max(0, Math.round((nowMs - startedAt) / 1000)),
      });
      continue;
    }
    if (sk.startsWith('CERT#')) {
      certifications.push({
        memberId: text(item, 'memberId'),
        certId: text(item, 'certId'),
        expiryDate: text(item, 'expiryDate'),
      });
      continue;
    }
    if (sk.startsWith('NERIS#')) {
      const status = nerisStatus(text(item, 'status'));
      if (!status) {
        continue;
      }
      const incidentId = text(item, 'incidentId');
      submissions.push({
        incidentId,
        status,
        href: `/api/v1/incidents/${incidentId}`,
      });
      continue;
    }
    if (sk.startsWith('COVERAGE#')) {
      gaps.push({ shiftId: text(item, 'shiftId'), gapReason: text(item, 'gapReason') });
    }
  }

  const pending = submissions.filter((submission) => submission.status === 'PENDING');
  const failed = submissions.filter((submission) => submission.status === 'FAILED');
  return {
    lastUpdated,
    staffing: {
      activeMemberCount,
      unavailableCount,
      shiftCoverage: { gapCount: gaps.length, gaps },
    },
    outOfServiceApparatus,
    expiringCertifications: { count: certifications.length, certifications },
    nerisCompliance: {
      pendingCount: pending.length,
      failedCount: failed.length,
      submissions,
    },
  };
}
