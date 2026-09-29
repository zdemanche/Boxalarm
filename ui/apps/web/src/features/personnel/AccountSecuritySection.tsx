import { useState } from 'react';
import { ApiError } from '../../lib/apiClient';
import { useAuth } from '../../auth/AuthContext';
import { ConfirmDialog } from '../../components/ui/Dialog';
import { resetMemberCredentials, revokeMemberSessions } from '../platform/api';
import type { Member } from './types';

/** Mirrors the Cedar policy for both actions (ADMIN_ONLY_ACTIONS: CHIEF/ADMIN). */
export function canUseAccountKillSwitches(roles: readonly string[]): boolean {
  return roles.includes('CHIEF') || roles.includes('ADMIN');
}

type Action = 'deviceLost' | 'resetCredentials';

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
 *  - Report device lost: signs the member out everywhere, stops their existing tokens within
 *    about 30 seconds and removes their push registration, so the lost phone stops showing
 *    dispatches. Their other devices need one sign-in.
 *  - Reset password and sign out: for a phished or leaked password. The old password stops
 *    working; the member sets a new one with "forgot password".
 * The server enforces both with Cedar; the buttons are only shown to the roles it admits.
 * No password or second-factor prompt is added here - the product's auth model is settled.
 */
export function AccountSecuritySection({ member }: { member: Member }) {
  const auth = useAuth();
  const [open, setOpen] = useState<Action | null>(null);
  const [message, setMessage] = useState('');
  const name = `${member.firstName} ${member.lastName}`;

  if (!canUseAccountKillSwitches(auth.roles)) {
    return null;
  }

  async function run(action: Action): Promise<void> {
    setMessage('');
    try {
      if (action === 'deviceLost') {
        await revokeMemberSessions(auth, member.memberId);
        setMessage(
          `${name} is signed out everywhere and their push registration is removed. ` +
            'They will need to sign in again on the devices they still have.',
        );
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
          `${name} will be signed out on every device within about 30 seconds and their phone ` +
          'will stop receiving dispatch notifications until they sign in again. SMS and voice ' +
          'paging continue.'
        }
        confirmLabel="Sign out everywhere"
        onConfirm={() => run('deviceLost')}
        danger
      />
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
