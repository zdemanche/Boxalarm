import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export const DEFAULT_SCBA_FLOW_TEST_INTERVAL_DAYS = 365;
export const DEFAULT_SCBA_HYDRO_TEST_INTERVAL_DAYS = 1825;

export interface ScbaRecordInput {
  readonly scbaUnitId: string;
  readonly cylinderId: string;
  readonly flowTestDate: string;
  readonly hydroTestDate: string;
}

export interface ScbaRecord {
  readonly deptId: string;
  readonly apparatusId: string;
  readonly scbaUnitId: string;
  readonly cylinderId: string;
  readonly flowTestDate: string;
  readonly hydroTestDate: string;
  readonly nextFlowTestDue: string;
  readonly nextHydroTestDue: string;
}

export type ScbaMetadataItem = Record<string, unknown>;

function addDaysToIsoDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function computeNextFlowTestDue(flowTestDate: string): string {
  return addDaysToIsoDate(flowTestDate, DEFAULT_SCBA_FLOW_TEST_INTERVAL_DAYS);
}

export function computeNextHydroTestDue(hydroTestDate: string): string {
  return addDaysToIsoDate(hydroTestDate, DEFAULT_SCBA_HYDRO_TEST_INTERVAL_DAYS);
}

function dueMonthBucket(isoDate: string): string {
  return isoDate.slice(0, 7);
}

function earlierIsoDate(a: string, b: string): string {
  return a <= b ? a : b;
}

export function buildScbaMetadataItem(
  deptId: VerifiedDeptId,
  apparatusId: string,
  input: ScbaRecordInput,
): ScbaMetadataItem {
  const nextFlowTestDue = computeNextFlowTestDue(input.flowTestDate);
  const nextHydroTestDue = computeNextHydroTestDue(input.hydroTestDate);
  const nextDue = earlierIsoDate(nextFlowTestDue, nextHydroTestDue);
  return {
    pk: buildDeptScopedPk(deptId, 'SCBA', input.scbaUnitId),
    sk: 'METADATA',
    entityType: 'SCBA_RECORD',
    scbaUnitId: input.scbaUnitId,
    apparatusId,
    cylinderId: input.cylinderId,
    flowTestDate: input.flowTestDate,
    hydroTestDate: input.hydroTestDate,
    nextFlowTestDue,
    nextHydroTestDue,
    gsi2pk: buildDeptScopedPk(deptId, 'DUE', 'SCBA_TEST', dueMonthBucket(nextDue)),
    gsi2sk: `${nextDue}#${input.scbaUnitId}`,
  };
}

export function buildScbaTestItem(
  deptId: VerifiedDeptId,
  apparatusId: string,
  input: ScbaRecordInput,
): ScbaMetadataItem {
  return {
    pk: buildDeptScopedPk(deptId, 'SCBA', input.scbaUnitId),
    sk: `TEST#${input.flowTestDate}`,
    entityType: 'SCBA_TEST',
    scbaUnitId: input.scbaUnitId,
    apparatusId,
    cylinderId: input.cylinderId,
    flowTestDate: input.flowTestDate,
    hydroTestDate: input.hydroTestDate,
  };
}

export function parseScbaMetadataItem(item: ScbaMetadataItem, deptId: string): ScbaRecord {
  return {
    deptId,
    apparatusId: String(item.apparatusId),
    scbaUnitId: String(item.scbaUnitId),
    cylinderId: String(item.cylinderId),
    flowTestDate: String(item.flowTestDate),
    hydroTestDate: String(item.hydroTestDate),
    nextFlowTestDue: String(item.nextFlowTestDue),
    nextHydroTestDue: String(item.nextHydroTestDue),
  };
}
