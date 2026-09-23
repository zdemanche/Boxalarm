export type MemberStatus = 'PROBATIONARY' | 'ACTIVE' | 'LOA' | 'RETIRED';

export interface Member {
  memberId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  status: MemberStatus;
  joinDate: string;
  rank: string;
  agencyId: string;
}

export interface CreateMemberInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  joinDate: string;
  rank: string;
  agencyId: string;
}

export interface Qualification {
  qualCode: string;
  grantedByCertId: string | null;
  currentlyEligible: boolean;
}

export interface LosapTotal {
  memberId: string;
  year: number;
  totalPoints: number;
}

export type AttendanceActivityType = 'CALL' | 'DRILL' | 'MEETING' | 'WORK_DETAIL' | 'STANDBY';

export interface AttendanceRecord {
  activityType: AttendanceActivityType;
  refId: string | null;
  occurredAt: number;
  hours: number;
  losapPointsAwarded?: number;
}
