/**
 * The chief's NERIS compliance tile, computed from incident METADATA rows (incident table
 * GSI1, read-only): how fast reports reach NERIS, how often NERIS sends them back, and which
 * reports have not gone yet.
 */

export const SUBMISSION_TARGET_SECONDS = 72 * 3_600;
export const MAX_OPEN_DRAFTS = 20;

export interface ComplianceIncident {
  readonly incidentId: string;
  readonly alarmAt: number;
  readonly createdBy?: string;
  readonly status?: string;
  readonly lockedAt?: number;
  readonly firstSubmittedAt?: number;
  readonly nerisIncidentId?: string;
  readonly nerisStatus?: string;
}

export interface OpenDraft {
  readonly id: string;
  readonly ageHours: number;
  readonly owner: string | null;
  readonly status: string | null;
  readonly locked: boolean;
}

export interface NerisCompliance {
  readonly windowDays: number;
  /** Of the calls at least 72 h old, the share NERIS accepted within 72 h of the alarm. */
  readonly submittedWithin72hPct: number | null;
  /** Of the reports NERIS holds, the share it rejected. */
  readonly rejectionRate: number | null;
  readonly submittedCount: number;
  readonly rejectedCount: number;
  readonly eligibleCount: number;
  /** Reports not yet accepted by NERIS, oldest first. */
  readonly openDrafts: readonly OpenDraft[];
}

function pct(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 1_000) / 10;
}

export function computeNerisCompliance(
  incidents: readonly ComplianceIncident[],
  nowEpochSeconds: number,
  windowDays: number,
): NerisCompliance {
  const eligible = incidents.filter(
    (i) => nowEpochSeconds - i.alarmAt >= SUBMISSION_TARGET_SECONDS,
  );
  const onTime = eligible.filter(
    (i) =>
      i.firstSubmittedAt !== undefined &&
      i.firstSubmittedAt - i.alarmAt <= SUBMISSION_TARGET_SECONDS,
  );
  const submitted = incidents.filter((i) => i.nerisIncidentId !== undefined);
  const rejected = submitted.filter((i) => i.nerisStatus === 'REJECTED');
  const openDrafts = incidents
    .filter((i) => i.firstSubmittedAt === undefined)
    .sort((a, b) => a.alarmAt - b.alarmAt)
    .slice(0, MAX_OPEN_DRAFTS)
    .map((i) => ({
      id: i.incidentId,
      ageHours: Math.max(0, Math.floor((nowEpochSeconds - i.alarmAt) / 3_600)),
      owner: i.createdBy ?? null,
      status: i.status ?? null,
      locked: i.lockedAt !== undefined,
    }));
  return {
    windowDays,
    submittedWithin72hPct: pct(onTime.length, eligible.length),
    rejectionRate: pct(rejected.length, submitted.length),
    submittedCount: submitted.length,
    rejectedCount: rejected.length,
    eligibleCount: eligible.length,
    openDrafts,
  };
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function toComplianceIncident(
  item: Record<string, unknown>,
): ComplianceIncident | undefined {
  const incidentId = str(item.incidentId);
  const alarmAt = num(item.alarmAt) ?? num(item.epochSeconds);
  if (!incidentId || alarmAt === undefined) return undefined;
  const optional = {
    createdBy: str(item.createdBy),
    status: str(item.status),
    lockedAt: num(item.lockedAt),
    firstSubmittedAt: num(item.firstSubmittedAt),
    nerisIncidentId: str(item.nerisIncidentId),
    nerisStatus: str(item.nerisStatus),
  };
  return {
    incidentId,
    alarmAt,
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
  };
}
