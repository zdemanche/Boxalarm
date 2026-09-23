import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export type TestType = 'HOSE' | 'LADDER' | 'PUMP' | 'AERIAL';
export type TestResult = 'PASS' | 'FAIL';

export interface TestRecord {
  readonly apparatusId: string;
  readonly deptId: string;
  readonly testType: TestType;
  readonly testDate: string;
  readonly result: TestResult;
  readonly nextDueDate: string;
}

export interface TestRecordInput {
  readonly testType: TestType;
  readonly testDate: string;
  readonly result: TestResult;
  readonly nextDueDate: string;
}

export type TestRecordItem = Record<string, unknown>;

const TEST_SK_PREFIX = 'TEST#';

/**
 * Pure append-only audit record — carries no GSI2 keys. The due-date index lives on a
 * separate, single-valued-per-(apparatusId, testType) item (buildTestDueItem) so a re-test
 * supersedes the prior due entry instead of leaving it live in GSI2 forever.
 */
export function buildTestRecordItem(
  deptId: VerifiedDeptId,
  apparatusId: string,
  input: TestRecordInput,
): TestRecordItem {
  return {
    pk: buildDeptScopedPk(deptId, 'APPARATUS', apparatusId),
    sk: `${TEST_SK_PREFIX}${input.testType}#${input.testDate}`,
    entityType: 'APPARATUS_TEST_RECORD',
    testType: input.testType,
    testDate: input.testDate,
    result: input.result,
    nextDueDate: input.nextDueDate,
  };
}

export function parseTestRecordItem(
  item: TestRecordItem,
  apparatusId: string,
  deptId: string,
): TestRecord {
  return {
    apparatusId,
    deptId,
    testType: item.testType as TestType,
    testDate: item.testDate as string,
    result: item.result as TestResult,
    nextDueDate: item.nextDueDate as string,
  };
}

export interface TestDueEntry {
  readonly apparatusId: string;
  readonly testType: TestType;
  readonly nextDueDate: string;
}

export type TestDueItem = Record<string, unknown>;

/**
 * The GSI2 partition key is stable (not month-bucketed) so both the read handler and the
 * scanner can do a single ranged Query (gsi2sk BETWEEN start AND end) instead of one Query
 * per calendar month in the window. Overwriting this fixed pk/sk on every submission (rather
 * than each TEST# record carrying its own GSI2 entry) means a re-test supersedes the prior
 * due date instead of leaving a stale entry live in the index forever.
 */
export function buildTestDueItem(
  deptId: VerifiedDeptId,
  apparatusId: string,
  input: TestRecordInput,
): TestDueItem {
  return {
    pk: buildDeptScopedPk(deptId, 'APPARATUS', apparatusId),
    sk: `DUE#${input.testType}`,
    entityType: 'APPARATUS_TEST_DUE',
    apparatusId,
    testType: input.testType,
    nextDueDate: input.nextDueDate,
    gsi2pk: buildDeptScopedPk(deptId, 'DUE', 'APPARATUS_TEST'),
    gsi2sk: `${input.nextDueDate}#${apparatusId}#${input.testType}`,
  };
}

export function parseTestDueItem(item: TestDueItem): TestDueEntry {
  return {
    apparatusId: String(item.apparatusId),
    testType: item.testType as TestType,
    nextDueDate: String(item.nextDueDate),
  };
}
