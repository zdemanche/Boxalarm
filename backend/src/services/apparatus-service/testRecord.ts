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
    gsi2pk: buildDeptScopedPk(deptId, 'DUE', 'APPARATUS_TEST', input.nextDueDate.slice(0, 7)),
    gsi2sk: `${input.nextDueDate}#${apparatusId}#${input.testType}`,
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
