import { describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { buildNotificationItem, buildPreferenceItem, CERT_EXPIRY_CATEGORY } from './repository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

describe('NOTIFICATION_PREFERENCE / NOTIFICATION entity contract (architecture Data Model §3.3 :141)', () => {
  it('NOTIFICATION_PREFERENCE carries sk = NOTIFPREF#{memberId}#{category} with per-channel opt-ins', () => {
    const item = buildPreferenceItem(
      DEPT_ID,
      'MBR-0012',
      CERT_EXPIRY_CATEGORY,
      { push: false, email: false },
      1_700_000_000_000,
    );
    expect(item.entityType).toBe('NOTIFICATION_PREFERENCE');
    expect(item.pk).toBe('DEPT#NICHOLS#MEMBER#MBR-0012');
    expect(item.sk).toBe('NOTIFPREF#MBR-0012#cert-expiry');
    expect(typeof item.channels.push).toBe('boolean');
    expect(typeof item.channels.email).toBe('boolean');
  });

  it('NOTIFICATION carries sk = NOTIF#{memberId}#{ts}#{notificationId}, nullable readAt, and a 180-day ttl', () => {
    const createdAt = 1_700_000_000_000;
    const item = buildNotificationItem(
      DEPT_ID,
      'MBR-0012',
      'NOTIF-0001',
      CERT_EXPIRY_CATEGORY,
      [{ certId: 'CERT-0091', expiryDate: '2027-01-10' }],
      createdAt,
    );
    expect(item.entityType).toBe('NOTIFICATION');
    expect(item.pk).toBe('DEPT#NICHOLS#MEMBER#MBR-0012');
    expect(item.sk).toBe(`NOTIF#MBR-0012#${createdAt}#NOTIF-0001`);
    expect(item.readAt).toBeNull();
    expect(item.ttl).toBe(Math.floor(createdAt / 1000) + 180 * 24 * 60 * 60);
    expect(item.gsi1pk).toBe('MEMBER#MBR-0012');
    expect(item.gsi1sk).toBe('NOTIFICATION#NOTIF-0001');
  });
});
