import type { CertificationStatus } from './certificationStatus';

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

export interface Certification {
  certId: string;
  certType: string;
  issuingAuthority: string;
  expiryDate: string; // ISO date
  status: CertificationStatus;
}

export interface Qualification {
  qualCode: string;
  grantedByCertId: string | null;
  currentlyEligible: boolean;
}

export interface ProfileUpdate {
  phone?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

export interface LosapTotal {
  year: number;
  totalPoints: number;
}

export interface MeRepository {
  getProfile(): Promise<MemberProfile>;
  getCertifications(): Promise<Certification[]>;
  getQualifications(): Promise<Qualification[]>;
  updateProfile(update: ProfileUpdate): Promise<MemberProfile>;
  getLosapTotal(): Promise<LosapTotal>;
}
