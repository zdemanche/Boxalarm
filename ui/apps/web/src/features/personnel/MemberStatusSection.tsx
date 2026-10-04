import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { canChangeMemberStatus } from '../../auth/roles';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/Dialog';
import { ApiError } from '../../lib/apiClient';
import { humanize } from '../../lib/labels';
import { updateMemberStatus } from './api';
import type { Member, MemberStatus } from './types';

/**
 * What the server lets anyone set (personnel statusTransitions.ts SETTABLE_STATUSES).
 * PROBATIONARY is set only when a member is created; the server refuses it here with 400.
 */
const SETTABLE: readonly MemberStatus[] = ['ACTIVE', 'LOA', 'RETIRED'];

/** Where `current` may go: RETIRED only back to ACTIVE (reinstatement), anything else anywhere. */
export function statusTargets(current: MemberStatus): MemberStatus[] {
  if (current === 'RETIRED') return ['ACTIVE'];
  return SETTABLE.filter((status) => status !== current);
}

/**
 * The consequence of each change, stated before it is applied (post-merge MAJOR-2). LOA and
 * RETIRED run the whole revocation chain: the login is disabled, every device is signed out and
 * the alerting snapshot stops paging the member on every channel.
 */
export function statusConsequence(name: string, from: MemberStatus, to: MemberStatus): string {
  if (to === 'LOA') {
    return (
      `${name} stops receiving all pages - push, SMS and voice - and is signed out of every ` +
      'device until set back to Active.'
    );
  }
  if (to === 'RETIRED') {
    return (
      `Retiring ${name} is meant to be permanent: they stop receiving all pages - push, SMS ` +
      'and voice - and are signed out of every device. Only a chief or admin can reinstate a ' +
      'retired member.'
    );
  }
  if (from === 'PROBATIONARY') {
    return `${name} completes probation. Their paging is unchanged.`;
  }
  return (
    `${name} is paged again on every channel as soon as this is saved. They must sign in again ` +
    'on each device before they can answer a page.'
  );
}

function problemText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.problem.status === 403) {
      return 'You are not allowed to change this member’s status.';
    }
    return error.problem.detail ?? error.problem.title ?? 'Could not change the status.';
  }
  return 'Could not change the status. Try again.';
}

/**
 * The status control is CHIEF/ADMIN on the web (the officer tier the API also admits is left to
 * a chief here: OQ-24 names the chief as the revoker). Choosing a status does nothing on its
 * own - a stray arrow key on a focused select used to retire a member - "Change status" opens a
 * confirmation that says what will happen, and only its confirm button saves.
 */
export function MemberStatusSection({ member }: { member: Member }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const targets = statusTargets(member.status);
  const [choice, setChoice] = useState<MemberStatus | ''>('');
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState('');
  const name = `${member.firstName} ${member.lastName}`;

  const mutation = useMutation({
    mutationFn: (status: MemberStatus) => updateMemberStatus(auth, member.memberId, status),
    onSuccess: (updated) => {
      queryClient.setQueryData(['personnel', 'members', member.memberId], updated);
      void queryClient.invalidateQueries({ queryKey: ['personnel', 'members'] });
    },
  });

  if (!canChangeMemberStatus(auth.roles)) {
    return null;
  }

  const selected = choice !== '' && targets.includes(choice) ? choice : '';
  const reinstating = member.status === 'RETIRED';

  async function apply(status: MemberStatus): Promise<void> {
    setMessage('');
    try {
      await mutation.mutateAsync(status);
      setMessage(`${name} is now ${humanize(status)}.`);
      setChoice('');
    } catch (error) {
      // Shown inline in the still-open dialog.
      throw new Error(problemText(error), { cause: error });
    }
  }

  return (
    <section aria-labelledby="member-status-heading" style={{ marginTop: 'var(--bx-space-lg)' }}>
      <h2
        id="member-status-heading"
        style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}
      >
        Status
      </h2>
      <p style={{ margin: 'var(--bx-space-xs) 0', fontSize: 14 }}>
        Current status: <strong>{humanize(member.status)}</strong>
      </p>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--bx-space-sm)',
          alignItems: 'end',
        }}
      >
        <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 600 }}>
          {reinstating ? 'Reinstate as' : 'New status'}
          <select
            aria-label="New member status"
            value={selected}
            onChange={(e) => setChoice(e.target.value as MemberStatus | '')}
            style={{
              minHeight: 'var(--bx-target-office)',
              minWidth: 200,
              padding: '0 var(--bx-space-sm)',
              fontSize: 14,
              fontWeight: 400,
              background: 'var(--bx-surface-raised)',
              color: 'var(--bx-fg)',
              border: '1px solid var(--bx-border)',
              borderRadius: 'var(--bx-radius-md)',
            }}
          >
            <option value="">Choose a status…</option>
            {targets.map((status) => (
              <option key={status} value={status}>
                {humanize(status)}
              </option>
            ))}
          </select>
        </label>
        <Button variant="secondary" disabled={selected === ''} onClick={() => setConfirming(true)}>
          {reinstating ? 'Reinstate member' : 'Change status'}
        </Button>
      </div>
      {/* Always mounted: a live region that appears already filled is skipped by some readers. */}
      <p role="status" aria-live="polite">
        {message}
      </p>
      <ConfirmDialog
        open={confirming && selected !== ''}
        onOpenChange={setConfirming}
        title={
          selected === ''
            ? ''
            : reinstating
              ? `Reinstate ${name} as ${humanize(selected)}?`
              : `Change ${name} to ${humanize(selected)}?`
        }
        consequence={selected === '' ? '' : statusConsequence(name, member.status, selected)}
        confirmLabel={
          selected === 'LOA'
            ? 'Set leave of absence'
            : selected === 'RETIRED'
              ? 'Retire member'
              : reinstating
                ? 'Reinstate'
                : 'Set active'
        }
        onConfirm={() => (selected === '' ? undefined : apply(selected))}
        danger={selected === 'LOA' || selected === 'RETIRED'}
      />
    </section>
  );
}
