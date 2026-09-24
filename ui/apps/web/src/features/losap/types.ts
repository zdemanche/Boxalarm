import type { AttendanceActivityType } from '../personnel/types';

export type LosapPointRules = Partial<Record<AttendanceActivityType, number>>;

export interface LosapRuleVersion {
  ruleVersionId: string;
  pointsByActivityType: LosapPointRules;
}
