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
