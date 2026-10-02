import { FormEvent, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { canUpdateServiceStatus } from '../../auth/roles';
import { Button, TextInput } from '../../components/ui';
import { resolveDefect } from './api';
import type { ResolveDefectResponse } from './types';

/**
 * Closes one defect with a required note (review MAJOR-2: nothing could resolve a defect).
 * Officer tier, like the service-status control. Resolving never changes the unit's service
 * status — the return to service stays its own deliberate action — so the result is handed to
 * `onResolved` and the PAGE warns when the unit is still out of service: this control lives in
 * the defect's own list row, which unmounts when the resolved defect leaves the list.
 */
export function ResolveDefectControl({
  unitId,
  defectId,
  description,
  onResolved,
}: {
  unitId: string;
  defectId: string;
  description: string;
  onResolved?: (result: ResolveDefectResponse) => void;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (resolutionNote: string) => resolveDefect(auth, unitId, defectId, resolutionNote),
    onSuccess: (result) => {
      setOpen(false);
      setNote('');
      setFormError(null);
      onResolved?.(result);
      void queryClient.invalidateQueries({ queryKey: ['apparatus'] });
    },
    onError: (error: Error) => setFormError(error.message),
  });

  if (!canUpdateServiceStatus(auth.roles)) {
    return null;
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="secondary"
        onClick={() => setOpen(true)}
        aria-label={`Resolve defect: ${description}`}
      >
        Resolve
      </Button>
    );
  }

  return (
    <form
      aria-label={`Resolve defect: ${description}`}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (note.trim().length === 0) {
          setFormError('A note saying how it was fixed is required.');
          return;
        }
        mutation.mutate(note.trim());
      }}
      style={{ display: 'flex', gap: 'var(--bx-space-sm)', alignItems: 'flex-end' }}
    >
      <TextInput
        label="How was it fixed?"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        error={formError ?? undefined}
      />
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Resolving…' : 'Confirm resolve'}
      </Button>
      <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

/** The page-level warning for a resolved OUT_OF_SERVICE defect on a unit still out of service. */
export function resolveWarningFor(
  unitId: string,
  result: ResolveDefectResponse,
): string | null {
  return result.unitStillOutOfService
    ? `${unitId} is still out of service — return it to service when it is ready.`
    : null;
}
