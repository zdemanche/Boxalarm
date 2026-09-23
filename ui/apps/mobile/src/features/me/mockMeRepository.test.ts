import { mockMeRepository } from './mockMeRepository';

test('getProfile resolves a member profile', async () => {
  const profile = await mockMeRepository.getProfile();
  expect(profile.memberId).toBeTruthy();
  expect(profile.firstName).toBeTruthy();
});

test('getCertifications resolves a non-empty list with valid statuses', async () => {
  const certs = await mockMeRepository.getCertifications();
  expect(certs.length).toBeGreaterThan(0);
  for (const cert of certs) {
    expect(['CURRENT', 'EXPIRED', 'REVOKED']).toContain(cert.status);
  }
});
