import { FormEvent, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, PageHeader, TextInput } from '../../components/ui';
import type { AttendanceActivityType } from '../personnel/types';
import { updateLosapRules } from './api';

const ACTIVITY_TYPES: AttendanceActivityType[] = [
  'CALL',
  'DRILL',
  'MEETING',
  'WORK_DETAIL',
  'STANDBY',
];

export function LosapSettingsPage() {
  const auth = useAuth();
  const [points, setPoints] = useState<Record<AttendanceActivityType, string>>({
    CALL: '',
    DRILL: '',
    MEETING: '',
    WORK_DETAIL: '',
    STANDBY: '',
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      updateLosapRules(
        auth,
        Object.fromEntries(
          ACTIVITY_TYPES.filter((type) => points[type].trim() !== '').map((type) => [
            type,
            Number(points[type]),
          ]),
        ),
      ),
  });

  return (
    <main id="main-content">
      <PageHeader
        title="LOSAP point rules"
        breadcrumbs={[{ label: 'Settings', to: '/settings' }, { label: 'LOSAP' }]}
      />
      <Card>
        <form
          aria-label="LOSAP point rules"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            saveMutation.mutate();
          }}
          style={{ display: 'grid', gap: 'var(--bx-space-md)', maxWidth: 320 }}
        >
          {ACTIVITY_TYPES.map((type) => (
            <TextInput
              key={type}
              label={`${type} points`}
              type="number"
              min="0"
              step="1"
              value={points[type]}
              onChange={(e) => setPoints((prev) => ({ ...prev, [type]: e.target.value }))}
            />
          ))}
          {saveMutation.error ? (
            <p role="alert" aria-live="assertive">
              {saveMutation.error.message}
            </p>
          ) : null}
          <Button type="submit" style={{ width: 'fit-content' }}>
            Save rules
          </Button>
        </form>
        {saveMutation.data ? (
          <p role="status" style={{ marginTop: 'var(--bx-space-sm)' }}>
            Saved as rule version {saveMutation.data.ruleVersionId}.
          </p>
        ) : null}
      </Card>
    </main>
  );
}
