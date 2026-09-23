import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export interface MaintenanceRecord {
  readonly apparatusId: string;
  readonly deptId: string;
  readonly performedAt: number;
  readonly description: string;
  readonly vendor: string;
  readonly cost: number;
  readonly scheduledNextAt: number | null;
}

export interface MaintenanceRecordInput {
  readonly performedAt: number;
  readonly description: string;
  readonly vendor: string;
  readonly cost: number;
  readonly scheduledNextAt: number | null;
}

export type MaintenanceRecordItem = Record<string, unknown>;

const MAINT_SK_PREFIX = 'MAINT#';

function dueMonthBucket(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}`;
}

export function buildMaintenanceRecordItem(
  deptId: VerifiedDeptId,
  apparatusId: string,
  input: MaintenanceRecordInput,
): MaintenanceRecordItem {
  return {
    pk: buildDeptScopedPk(deptId, 'APPARATUS', apparatusId),
    sk: `${MAINT_SK_PREFIX}${input.performedAt}`,
    entityType: 'MAINTENANCE_RECORD',
    description: input.description,
    vendor: input.vendor,
    cost: input.cost,
    scheduledNextAt: input.scheduledNextAt,
    ...(input.scheduledNextAt !== null
      ? {
          gsi2pk: buildDeptScopedPk(
            deptId,
            'DUE',
            'MAINTENANCE_RECORD',
            dueMonthBucket(input.scheduledNextAt),
          ),
          gsi2sk: `${input.scheduledNextAt}#${apparatusId}`,
        }
      : {}),
  };
}

export function parseMaintenanceRecordItem(
  item: MaintenanceRecordItem,
  apparatusId: string,
  deptId: string,
): MaintenanceRecord {
  const sk = String(item.sk);
  return {
    apparatusId,
    deptId,
    performedAt: Number(sk.slice(MAINT_SK_PREFIX.length)),
    description: String(item.description),
    vendor: String(item.vendor),
    cost: Number(item.cost),
    scheduledNextAt:
      item.scheduledNextAt === null || item.scheduledNextAt === undefined
        ? null
        : Number(item.scheduledNextAt),
  };
}
