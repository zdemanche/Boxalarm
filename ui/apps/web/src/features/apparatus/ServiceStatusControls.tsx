import { FormEvent, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { canUpdateServiceStatus } from '../../auth/roles';
import { Button, Card, StatusChip, TextInput } from '../../components/ui';
import { setServiceStatus } from './api';
import type { ApparatusDetail } from './types';
import styles from './Apparatus.module.css';

function formatElapsed(elapsedSeconds: number): string {
  const days = Math.floor(elapsedSeconds / 86400);
  if (days <= 0) return 'today';
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * The unit's service-status controls. The status chip itself sits in the page header beside the
 * unit's name (and announces the change); this card says why it is out and changes it.
 */
export function ServiceStatusControls({ unit }: { unit: ApparatusDetail }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canControl = canUpdateServiceStatus(auth.roles);
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: { status: 'IN_SERVICE' | 'OUT_OF_SERVICE'; reason?: string }) =>
      setServiceStatus(auth, unit.unitId, input.status, input.reason),
    onSuccess: () => {
      setReason('');
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['apparatus', unit.unitId] });
      void queryClient.invalidateQueries({ queryKey: ['apparatus'] });
    },
    onError: (error: Error) => setFormError(error.message),
  });

  return (
    <Card title="Service status">
      {unit.status === 'OUT_OF_SERVICE' && unit.outOfService ? (
        <p className={styles.statusReason}>
          {unit.outOfService.reason} since {formatElapsed(unit.outOfService.elapsedSeconds)} ago
        </p>
      ) : null}
      {unit.failedTests.length > 0 ? (
        <div role="alert" className={styles.failedTests}>
          <StatusChip status="danger">Failed tests</StatusChip>
          {unit.failedTests.map((t) => t.testType).join(', ')}
        </div>
      ) : null}

      {!canControl ? (
        <p className={styles.message}>
          Changing service status is limited to officers, the apparatus officer, the chief and the
          administrator.
        </p>
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
          className={styles.formStack}
        >
          <TextInput
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            error={formError ?? undefined}
          />
          <div className={styles.formActions}>
            <Button type="submit" variant="secondary" loading={mutation.isPending}>
              Place out of service
            </Button>
          </div>
        </form>
      ) : (
        <>
          {formError ? (
            <p role="alert" className={styles.error} style={{ marginBottom: 'var(--bx-space-sm)' }}>
              {formError}
            </p>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            loading={mutation.isPending}
            onClick={() => mutation.mutate({ status: 'IN_SERVICE' })}
          >
            Return to service
          </Button>
        </>
      )}
    </Card>
  );
}
