import { FormEvent, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { setServiceStatus } from './api';
import { serviceStatusRole, StatusBadge } from './StatusBadge';
import type { ApparatusDetail } from './types';

function elapsedSince(epochSeconds: number): string {
  const days = Math.floor((Date.now() / 1000 - epochSeconds) / 86400);
  if (days <= 0) return 'today';
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function ServiceStatusControls({ unit }: { unit: ApparatusDetail }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canControl = auth.roles.includes('APPARATUS') || auth.roles.includes('CHIEF');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: { status: 'IN_SERVICE' | 'OUT_OF_SERVICE'; reason?: string }) =>
      setServiceStatus(auth, unit.unitId, input.status, input.reason),
    onSuccess: () => {
      setReason('');
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['apparatus', unit.apparatusId] });
      void queryClient.invalidateQueries({ queryKey: ['apparatus'] });
    },
    onError: (error: Error) => setFormError(error.message),
  });

  return (
    <section style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
      <p role="status" style={{ fontSize: 'var(--boxalarm-font-size-lg)' }}>
        <StatusBadge
          role={serviceStatusRole(unit.status)}
          word={unit.status === 'IN_SERVICE' ? 'In service' : 'Out of service'}
        />
      </p>
      {unit.status === 'OUT_OF_SERVICE' && unit.oosReason ? (
        <p>
          {unit.oosReason}
          {unit.oosSince ? ` since ${elapsedSince(unit.oosSince)} ago` : null}
        </p>
      ) : null}

      {!canControl ? (
        <p>Changing service status is limited to the apparatus officer and the chief.</p>
      ) : unit.status === 'IN_SERVICE' ? (
        <form
          aria-label="Place out of service"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (reason.trim().length === 0) {
              setFormError('reason is required when placing a unit out of service');
              return;
            }
            mutation.mutate({ status: 'OUT_OF_SERVICE', reason: reason.trim() });
          }}
          style={{
            display: 'grid',
            gap: 'var(--boxalarm-spacing-sm)',
            maxWidth: 480,
            marginTop: 'var(--boxalarm-spacing-md)',
          }}
        >
          <label style={{ display: 'grid', gap: 4 }}>
            Reason
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          {formError ? (
            <p role="alert" aria-live="assertive">
              {formError}
            </p>
          ) : null}
          <button type="submit" style={{ minHeight: 44, maxWidth: 240 }}>
            Place out of service
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => mutation.mutate({ status: 'IN_SERVICE' })}
          style={{ minHeight: 44, marginTop: 'var(--boxalarm-spacing-md)' }}
        >
          Return to service
        </button>
      )}
    </section>
  );
}
