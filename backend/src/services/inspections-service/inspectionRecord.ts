import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export type ViolationStatus = 'open' | 'resolved';

export interface Violation {
  readonly code: string;
  readonly description: string;
  readonly status: ViolationStatus;
}

export interface InspectionItem {
  readonly pk: string;
  readonly sk: string;
  readonly entityType: 'INSPECTION_RECORD';
  readonly scheduledDate: string;
  readonly conductedDate?: string;
  readonly conductedBy?: string;
  readonly violations: readonly Violation[];
  readonly photoS3Keys?: readonly string[];
  readonly nextDueDate: string;
  readonly gsi2pk: string;
  readonly gsi2sk: string;
}

export interface ApiInspection {
  readonly occupancyId: string;
  readonly inspectionId: string;
  readonly scheduledDate: string;
  readonly conductedDate?: string;
  readonly conductedBy?: string;
  readonly violations: readonly Violation[];
  readonly photoS3Keys?: readonly string[];
  readonly nextDueDate: string;
}

export class ValidationError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'ValidationError';
    this.detail = detail;
  }
}

export function buildInspectionKeys(
  deptId: VerifiedDeptId,
  occupancyId: string,
  inspectionId: string,
): { pk: string; sk: string } {
  return {
    pk: buildDeptScopedPk(deptId, 'OCCUPANCY', occupancyId),
    sk: `INSPECTION#${inspectionId}`,
  };
}

export function buildDueGsi2Pk(deptId: VerifiedDeptId, month: string): string {
  return buildDeptScopedPk(deptId, 'DUE', 'INSPECTION_RECORD', month);
}

export function buildDueGsi2Sk(nextDueDate: string, inspectionId: string): string {
  return `${nextDueDate}#${inspectionId}`;
}

export function buildDueGsi2Keys(
  deptId: VerifiedDeptId,
  nextDueDate: string,
  inspectionId: string,
): { gsi2pk: string; gsi2sk: string } {
  return {
    gsi2pk: buildDueGsi2Pk(deptId, nextDueDate.slice(0, 7)),
    gsi2sk: buildDueGsi2Sk(nextDueDate, inspectionId),
  };
}

const OCCUPANCY_PK_PATTERN = /^DEPT#.+#OCCUPANCY#(.+)$/;
const INSPECTION_SK_PREFIX = 'INSPECTION#';

export function toApiInspection(item: InspectionItem): ApiInspection {
  const occupancyId = item.pk.match(OCCUPANCY_PK_PATTERN)?.[1];
  const inspectionId = item.sk.startsWith(INSPECTION_SK_PREFIX)
    ? item.sk.slice(INSPECTION_SK_PREFIX.length)
    : undefined;
  if (!occupancyId || !inspectionId) {
    throw new Error(
      `INSPECTION_RECORD item has a malformed key pair — key values: ${item.pk} / ${item.sk}`,
    );
  }
  return {
    occupancyId,
    inspectionId,
    scheduledDate: item.scheduledDate,
    ...(item.conductedDate !== undefined && { conductedDate: item.conductedDate }),
    ...(item.conductedBy !== undefined && { conductedBy: item.conductedBy }),
    violations: item.violations,
    ...(item.photoS3Keys !== undefined && { photoS3Keys: item.photoS3Keys }),
    nextDueDate: item.nextDueDate,
  };
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isPkSafeString(value: unknown): value is string {
  return isNonEmptyString(value) && !value.includes('#');
}

export interface SchedulePayload {
  readonly occupancyId: string;
  readonly scheduledDate: string;
}

export function parseSchedulePayload(body: unknown): SchedulePayload {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('Request body must be a JSON object');
  }
  const { occupancyId, scheduledDate } = body as Record<string, unknown>;
  if (!isPkSafeString(occupancyId)) {
    throw new ValidationError("occupancyId is required and must be a non-empty string without '#'");
  }
  if (!isNonEmptyString(scheduledDate) || Number.isNaN(Date.parse(scheduledDate))) {
    throw new ValidationError('scheduledDate is required and must be a valid ISO date string');
  }
  return { occupancyId, scheduledDate };
}

export function validateViolation(value: unknown, index: number): Violation {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError(`violations[${index}] must be an object`);
  }
  const { code, description, status } = value as Record<string, unknown>;
  if (!isNonEmptyString(code)) {
    throw new ValidationError(
      `violations[${index}].code is required and must be a non-empty string`,
    );
  }
  if (!isNonEmptyString(description)) {
    throw new ValidationError(
      `violations[${index}].description is required and must be a non-empty string`,
    );
  }
  if (status !== 'open' && status !== 'resolved') {
    throw new ValidationError(`violations[${index}].status must be "open" or "resolved"`);
  }
  return { code, description, status };
}

export interface ConductPayload {
  readonly occupancyId: string;
  readonly inspectionId: string;
  readonly violations: readonly Violation[];
}

export function parseConductPayload(body: unknown): ConductPayload {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('Request body must be a JSON object');
  }
  const { occupancyId, inspectionId, violations } = body as Record<string, unknown>;
  if (!isPkSafeString(occupancyId)) {
    throw new ValidationError("occupancyId is required and must be a non-empty string without '#'");
  }
  if (!isPkSafeString(inspectionId)) {
    throw new ValidationError(
      "inspectionId is required and must be a non-empty string without '#'",
    );
  }
  if (!Array.isArray(violations)) {
    throw new ValidationError('violations must be an array');
  }
  return {
    occupancyId,
    inspectionId,
    violations: violations.map((v, index) => validateViolation(v, index)),
  };
}

export interface DueWindow {
  readonly months: readonly string[];
  readonly startBound: string;
  readonly endBound: string;
}

const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export function resolveDueWindow(
  query: Record<string, string | undefined> | null | undefined,
  now: Date,
): DueWindow {
  const monthParam = query?.month;
  let start: Date;
  if (monthParam !== undefined) {
    if (!MONTH_PATTERN.test(monthParam)) {
      throw new ValidationError('month must be in YYYY-MM format');
    }
    start = new Date(`${monthParam}-01T00:00:00.000Z`);
  } else {
    start = now;
  }

  const leadDaysParam = query?.leadDays;
  let leadDays = 30;
  if (leadDaysParam !== undefined) {
    const parsed = Number(leadDaysParam);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new ValidationError('leadDays must be a non-negative integer');
    }
    leadDays = parsed;
  }

  const end = new Date(start.getTime() + leadDays * MS_PER_DAY);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  const months: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor.getTime() <= endMonth.getTime()) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return { months, startBound: startDate, endBound: `${endDate}#￿` };
}

export function hasInspectionId(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    isNonEmptyString((body as Record<string, unknown>).inspectionId)
  );
}
