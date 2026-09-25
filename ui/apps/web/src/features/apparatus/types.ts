export type ApparatusStatus = 'IN_SERVICE' | 'OUT_OF_SERVICE';

// Matches the backend's ApparatusListItem.outOfService shape (apparatus-service repository.ts) —
// the real API nests the OOS reason/start-time/elapsed-time under one object, never as flat
// top-level fields on Apparatus.
export interface OutOfServiceSummary {
  reason: string;
  startAt: number;
  elapsedSeconds: number;
}

export interface Apparatus {
  apparatusId: string;
  unitId: string;
  type: string;
  status: ApparatusStatus;
  outOfService?: OutOfServiceSummary;
}

export interface CreateApparatusInput {
  unitId: string;
  type: string;
}

export interface OpenDefectSummary {
  defectId: string;
  description: string;
  severity: 'MINOR' | 'MAJOR' | 'OUT_OF_SERVICE';
  reportedAt: number;
  photoS3Key: string | null;
  /** Signed read URL when the apparatus detail payload includes one. An S3 key is not a URL. */
  photoUrl?: string | null;
}

export interface FailedTestSummary {
  testType: string;
  testDate: string;
  nextDueDate: string;
}

export interface ApparatusDetail extends Apparatus {
  openDefects: OpenDefectSummary[];
  failedTests: FailedTestSummary[];
}

export interface ChecklistItem {
  code: string;
  label: string;
  requiresPhoto: boolean;
}

export interface ChecklistTemplate {
  templateId: string;
  name: string;
  applicableApparatusIds: string[];
  items: ChecklistItem[];
}

export interface MaintenanceRecord {
  apparatusId: string;
  performedAt: number;
  description: string;
  vendor: string;
  cost: number;
  scheduledNextAt: number | null;
}

export interface CreateMaintenanceInput {
  description: string;
  vendor: string;
  cost: number;
  scheduledNextAt?: number | null;
}

export interface ScbaRecord {
  apparatusId: string;
  scbaUnitId: string;
  cylinderId: string;
  flowTestDate: string;
  hydroTestDate: string;
  nextFlowTestDue: string;
  nextHydroTestDue: string;
}

export interface CreateScbaInput {
  scbaUnitId: string;
  cylinderId: string;
  flowTestDate: string;
  hydroTestDate: string;
}

export interface ScbaDueEntry {
  apparatusId: string;
  scbaUnitId: string;
  cylinderId: string;
  testType: 'SCBA_FLOW' | 'SCBA_HYDRO';
  dueDate: string;
}

export type TestType = 'HOSE' | 'LADDER' | 'PUMP' | 'AERIAL';
export type TestResult = 'PASS' | 'FAIL';

export interface TestRecord {
  apparatusId: string;
  testType: TestType;
  testDate: string;
  result: TestResult;
  nextDueDate: string;
}

export interface CreateTestRecordInput {
  testType: TestType;
  result: TestResult;
  nextDueDate: string;
}

export interface TestingScheduleEntry {
  unitId: string;
  testType: TestType;
  nextDueDate: string;
}

export interface CompartmentItem {
  itemId: string;
  itemName: string;
  quantity: number;
}

export interface CompartmentGroup {
  compartmentCode: string;
  items: CompartmentItem[];
}

export interface CreateInventoryItemInput {
  compartmentCode: string;
  itemName: string;
  quantity: number;
}

export interface ComplianceEntry {
  unitId: string;
  expectedChecks: number;
  actualChecks: number;
  compliant: boolean;
}
