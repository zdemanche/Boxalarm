import { describe, expect, test } from 'vitest';
import { canAccessPath, navSectionsForRoles, routesForRoles } from './routeTable';

describe('routeTable', () => {
  test('CHIEF nav includes dashboard, roster, audit-log; excludes settings', () => {
    const labels = routesForRoles(['CHIEF']).map((r) => r.label);
    expect(labels).toContain('Dashboard');
    expect(labels).toContain('Live roster');
    expect(labels).toContain('Audit log');
    expect(labels).not.toContain('Settings');
    // The chief reads schedule and training (officer-tier Cedar actions include CHIEF).
    expect(labels).toContain('Schedule');
    expect(labels).toContain('Certifications');
    expect(labels).toContain('Training events');
  });

  test('OFFICER and ADMIN see Apparatus; nobody sees "Personnel"', () => {
    expect(routesForRoles(['OFFICER']).map((r) => r.label)).toContain('Apparatus');
    expect(routesForRoles(['ADMIN']).map((r) => r.label)).toContain('Apparatus');
    expect(canAccessPath('/apparatus/E1', ['OFFICER'])).toBe(true);
    for (const role of ['OFFICER', 'TRAINING', 'APPARATUS', 'ADMIN', 'CHIEF'] as const) {
      expect(routesForRoles([role]).map((r) => r.label)).not.toContain('Personnel');
    }
  });

  test('nav sections follow the design.md group order and drop empty groups', () => {
    const chief = navSectionsForRoles(['CHIEF']).map((s) => s.group);
    expect(chief).toEqual(['Overview', 'Response', 'People', 'Apparatus', 'Prevention', 'Admin']);
    const apparatusOfficer = navSectionsForRoles(['APPARATUS']);
    expect(apparatusOfficer.map((s) => s.group)).toEqual(['Overview', 'People', 'Apparatus']);
    expect(apparatusOfficer[2]?.routes.map((r) => r.label)).toEqual(['Apparatus', 'Inventory']);
  });

  test('ADMIN nav includes settings, audit-log and a dashboard to land on', () => {
    const labels = routesForRoles(['ADMIN']).map((r) => r.label);
    expect(labels).toContain('Settings');
    expect(labels).toContain('Audit log');
    expect(labels).toContain('Members');
    expect(labels).toContain('Dashboard');
    expect(labels).not.toContain('Live roster');
  });

  test('ADMIN reaches the incident pages (report unlock is CHIEF/ADMIN)', () => {
    expect(canAccessPath('/incidents', ['ADMIN'])).toBe(true);
    expect(canAccessPath('/incidents/NICHOLS-4471-1798000000', ['ADMIN'])).toBe(true);
  });

  test('MEMBER nav is their own self-service: availability, nothing department-wide', () => {
    expect(routesForRoles(['MEMBER']).map((r) => r.navPath)).toEqual(['/', '/availability']);
  });

  test('every role can mark themselves unavailable', () => {
    for (const role of ['MEMBER', 'OFFICER', 'TRAINING', 'APPARATUS', 'ADMIN', 'CHIEF'] as const) {
      expect(canAccessPath('/availability', [role])).toBe(true);
    }
  });

  test('every role can reach its own notification inbox, which stays out of PrimaryNav', () => {
    for (const role of ['MEMBER', 'OFFICER', 'TRAINING', 'APPARATUS', 'ADMIN', 'CHIEF'] as const) {
      expect(canAccessPath('/notifications', [role])).toBe(true);
      expect(routesForRoles([role]).map((r) => r.navPath)).not.toContain('/notifications');
    }
  });

  test('CAD sources are CHIEF/ADMIN only, with their own nav entry (CHIEF has no /settings)', () => {
    expect(routesForRoles(['CHIEF']).map((r) => r.label)).toContain('CAD sources');
    expect(routesForRoles(['ADMIN']).map((r) => r.label)).toContain('CAD sources');
    for (const role of ['MEMBER', 'OFFICER', 'TRAINING', 'APPARATUS'] as const) {
      expect(canAccessPath('/settings/cad-sources', [role])).toBe(false);
    }
  });

  test('canAccessPath enforces role grants including param routes', () => {
    expect(canAccessPath('/settings', ['ADMIN'])).toBe(true);
    expect(canAccessPath('/settings', ['CHIEF'])).toBe(false);
    expect(canAccessPath('/personnel/abc', ['OFFICER'])).toBe(true);
    expect(canAccessPath('/personnel/abc', ['MEMBER'])).toBe(false);
    expect(canAccessPath('/audit-log', ['CHIEF'])).toBe(true);
  });
});
