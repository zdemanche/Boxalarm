// Certification is the training-service API's shape (../training/types) -- re-exported here
// rather than redefined, so the mock repository and the real API client stay interchangeable.
import type { Certification } from '../training/types';
export type { Certification };

// Shaped to match architecture.md's MEMBER and CERTIFICATION entities (Data Model §3.3), so
// swapping the mock repository for a real API client later is a data-layer change, not a
// screen rewrite.
export interface MemberProfile {
  memberId: string;
  firstName: string;
  lastName: string;
  rank: string;
  email: string;
  phone: string;
}

export interface MeRepository {
  getProfile(): Promise<MemberProfile>;
  getCertifications(): Promise<Certification[]>;
}
