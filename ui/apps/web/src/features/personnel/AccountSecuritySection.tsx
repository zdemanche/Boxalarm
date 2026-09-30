import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../../lib/apiClient';
import { useAuth } from '../../auth/AuthContext';
import { ConfirmDialog } from '../../components/ui/Dialog';
import { listMemberDevices, resetMemberCredentials, revokeMemberSessions } from '../platform/api';
import type { MemberDevice } from '../platform/types';
import type { Member } from './types';

/** Mirrors the Cedar policy for both actions (ADMIN_ONLY_ACTIONS: CHIEF/ADMIN). */
export function canUseAccountKillSwitches(roles: readonly string[]): boolean {
  return roles.includes('CHIEF') || roles.includes('ADMIN');
}

type Action = 'deviceLost' | 'resetCredentials';

/** The radio value for removing push from every device (the default). */
const ALL_DEVICES = '';

function platformName(platform: string | null): string {
  if (platform === 'APNS') return 'iPhone';
  if (platform === 'FCM') return 'Android';
  return platform ?? 'Unknown device';
}

/**
 * Review minor 2: the message follows what the server did, not what was asked. `push` is
 * 'invalidated' (removed), or 'no-push-entry' / 'no-member' (nothing to remove: the chosen
 * device was already removed or re-registered under a new id). Sessions are signed out either
 * way.
 */
export function deviceLostMessage(
  name: string,
  chosen: MemberDevice | undefined,
  push: string | undefined,
): string {
  const signedOut = `${name} is signed out everywhere and must sign in again on each device.`;
  if (push !== 'invalidated') {
    return chosen
      ? `${signedOut} ${describeDevice(chosen)} was not found - it was already removed or ` +
          'has registered again. Paging on their other devices is unchanged.'
      : `${signedOut} No devices were registered for push notifications.`;
  }
  return chosen
    ? `${signedOut} ${describeDevice(chosen)} no longer receives dispatch notifications; ` +
        'their other devices keep receiving pages.'
    : `${signedOut} None of their devices receives dispatch notifications until they sign in ` +
        'again.';
}

/** "iPhone · registered 9/29/2026, 3:04 PM · id …7f3a9c" - enough to tell two phones apart. */
export function describeDevice(device: MemberDevice): string {
  const parts = [platformName(device.platform)];
  if (device.registeredAt !== null) {
    parts.push(`registered ${new Date(device.registeredAt).toLocaleString()}`);
  }
  if (device.deviceId !== null) {
    parts.push(`id …${device.deviceId.slice(-6)}`);
  }
  if (!device.valid) {
    parts.push('no longer reachable');
  }
  return parts.join(' · ');
}

function problemText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.problem.status === 403) {
      return 'You are not allowed to do this. Only a chief or admin can.';
    }
    return error.problem.detail ?? error.problem.title ?? fallback;
  }
  return fallback;
}

/**
 * OQ-24: the two controls that end a member's access, for a chief at 03:00 without curl.
 *  - Report device lost: signs the member out everywhere and stops their existing tokens within
 *    about 30 seconds (per-device sign-out is not possible yet), and removes the push
 *    registration of the device the admin picks - or of every device, the default - so the
 *    lost phone stops showing dispatches. Every device needs one sign-in; only the removed
 *    ones stop receiving pages.
 *  - Reset password and sign out: for a phished or leaked password. The old password stops
 *    working; the member sets a new one with "forgot password".
 * The server enforces both with Cedar; the buttons are only shown to the roles it admits.
 * No password or second-factor prompt is added here - the product's auth model is settled.
 */
export function AccountSecuritySection({ member }: { member: Member }) {
  const auth = useAuth();
  const [open, setOpen] = useState<Action | null>(null);
  const [message, setMessage] = useState('');
  const [lostDeviceId, setLostDeviceId] = useState(ALL_DEVICES);
  const name = `${member.firstName} ${member.lastName}`;
  const allowed = canUseAccountKillSwitches(auth.roles);

  const devicesQuery = useQuery({
    queryKey: ['platform', 'sessions', member.memberId, 'devices'],
    queryFn: () => listMemberDevices(auth, member.memberId),
    enabled: allowed && open === 'deviceLost',
    staleTime: 0,
  });

  // Each report starts from "All devices": a choice left over from an earlier report must
  // never silently narrow this one.
  useEffect(() => {
    if (open === 'deviceLost') {
      setLostDeviceId(ALL_DEVICES);
    }
  }, [open]);

  if (!allowed) {
    return null;
  }

  const devices = devicesQuery.data?.devices ?? [];
  const selectable = devices.filter(
    (device): device is MemberDevice & { deviceId: string } => device.deviceId !== null,
  );
  const unidentified = devices.length - selectable.length;
  const chosen = selectable.find((device) => device.deviceId === lostDeviceId);

  async function run(action: Action): Promise<void> {
    setMessage('');
    try {
      if (action === 'deviceLost') {
        const result = await revokeMemberSessions(auth, member.memberId, chosen?.deviceId);
        setMessage(deviceLostMessage(name, chosen, result.push));
      } else {
        await resetMemberCredentials(auth, member.memberId);
        setMessage(
          `${name}'s password no longer works and every session is signed out. ` +
            'They can set a new one with "Forgot password".',
        );
      }
    } catch (error) {
      // Shown inline in the still-open dialog.
      throw new Error(
        problemText(
          error,
          action === 'deviceLost'
            ? 'Could not sign this member out. Try again.'
            : 'Could not reset this member’s password. Try again.',
        ),
        { cause: error },
      );
    }
  }

  return (
    <section
      aria-labelledby="account-security-heading"
      style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}
    >
      <h2
        id="account-security-heading"
        style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}
      >
        Account security
      </h2>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--boxalarm-spacing-sm)',
          marginTop: 'var(--boxalarm-spacing-sm)',
        }}
      >
        <button type="button" onClick={() => setOpen('deviceLost')} style={{ minHeight: 44 }}>
          Report device lost
        </button>
        <button type="button" onClick={() => setOpen('resetCredentials')} style={{ minHeight: 44 }}>
          Reset password and sign out
        </button>
      </div>
      {/* Always mounted: a live region that appears already filled is skipped by some readers. */}
      <p role="status" aria-live="polite">
        {message}
      </p>
      <ConfirmDialog
        open={open === 'deviceLost'}
        onOpenChange={(next) => setOpen(next ? 'deviceLost' : null)}
        title={`Report a lost device for ${name}?`}
        consequence={
          `${name} will be signed out on every device within about 30 seconds and must sign ` +
          'in again on each one. ' +
          (chosen
            ? 'Only the lost device stops receiving dispatch notifications; their other ' +
              'devices keep receiving pages. '
            : 'None of their devices receives dispatch notifications until they sign in ' +
              'again. ') +
          'SMS and voice paging continue.'
        }
        confirmLabel="Sign out everywhere"
        onConfirm={() => run('deviceLost')}
        danger
      >
        <fieldset style={{ border: 'none', padding: 0, margin: 'var(--boxalarm-spacing-sm) 0' }}>
          <legend style={{ fontWeight: 600 }}>Which device was lost?</legend>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}>
            <input
              type="radio"
              name="lost-device"
              value={ALL_DEVICES}
              checked={chosen === undefined}
              onChange={() => setLostDeviceId(ALL_DEVICES)}
            />
            All devices
          </label>
          {selectable.map((device) => (
            <label
              key={device.deviceId}
              style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}
            >
              <input
                type="radio"
                name="lost-device"
                value={device.deviceId}
                checked={chosen?.deviceId === device.deviceId}
                onChange={() => setLostDeviceId(device.deviceId)}
              />
              {describeDevice(device)}
            </label>
          ))}
          {devicesQuery.isPending ? <p>Loading registered devices…</p> : null}
          {devicesQuery.isError ? (
            <p>Could not load this member’s devices. “All devices” still works.</p>
          ) : null}
          {devicesQuery.isSuccess && devices.length === 0 ? (
            <p>No devices are registered for push notifications.</p>
          ) : null}
          {unidentified > 0 ? (
            <p>
              {unidentified === 1
                ? 'One older registration has no device id; only “All devices” removes it.'
                : `${unidentified} older registrations have no device id; only “All devices” removes them.`}
            </p>
          ) : null}
        </fieldset>
      </ConfirmDialog>
      <ConfirmDialog
        open={open === 'resetCredentials'}
        onOpenChange={(next) => setOpen(next ? 'resetCredentials' : null)}
        title={`Reset ${name}'s password and sign them out?`}
        consequence={
          `${name}'s current password will stop working and every session will end. They set ` +
          'a new password themselves with "Forgot password" (a code goes to their email).'
        }
        confirmLabel="Reset password"
        onConfirm={() => run('resetCredentials')}
        danger
      />
    </section>
  );
}
