import type { MeRepository, MemberProfile } from './types';

// No backend access exists yet (boxalarm-backend/boxalarm-infrastructure) - this mock stands
// in for the eventual platform-service client, matching MeRepository's interface exactly so
// swapping it later touches this one file, not the screens.
let profile: MemberProfile = {
  memberId: 'MBR-0012',
  firstName: 'Jamie',
  lastName: 'Rios',
  rank: 'Firefighter',
  email: 'jrios@example.org',
  phone: '(203) 555-0142',
};

export const mockMeRepository: MeRepository = {
  async getProfile() {
    return profile;
  },

  async updateProfile(update) {
    profile = { ...profile, ...update };
    return profile;
  },

  async getQualifications() {
    return [
      { qualCode: 'INTERIOR', grantedByCertId: 'CERT-0091', currentlyEligible: true },
      { qualCode: 'DRIVER_OPERATOR', grantedByCertId: 'CERT-0104', currentlyEligible: false },
    ];
  },

  async getLosapTotal() {
    return { year: new Date().getFullYear(), totalPoints: 12 };
  },

  async getCertifications() {
    return [
      {
        certId: 'CERT-0091',
        certType: 'FF1',
        issuingAuthority: 'CT DESPP',
        expiryDate: '2027-01-10',
        status: 'CURRENT',
      },
      {
        certId: 'CERT-0104',
        certType: 'Hazmat Ops',
        issuingAuthority: 'CT DESPP',
        expiryDate: '2026-03-01',
        status: 'EXPIRED',
      },
      {
        certId: 'CERT-0118',
        certType: 'Driver/Operator',
        issuingAuthority: 'CT DESPP',
        expiryDate: '2028-06-15',
        status: 'CURRENT',
      },
    ];
  },
};
