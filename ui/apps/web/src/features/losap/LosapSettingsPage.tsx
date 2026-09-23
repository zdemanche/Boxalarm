import { FormEvent, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
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
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>Settings</h1>
      <section style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
        <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>LOSAP point rules</h2>
        <form
          aria-label="LOSAP point rules"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            saveMutation.mutate();
          }}
          style={{
            marginTop: 'var(--boxalarm-spacing-md)',
            display: 'grid',
            gap: 'var(--boxalarm-spacing-md)',
            maxWidth: 320,
          }}
        >
          {ACTIVITY_TYPES.map((type) => (
            <label key={type} style={{ display: 'grid', gap: 4 }}>
              {type} points
              <input
                type="number"
                min="0"
                step="1"
                value={points[type]}
                onChange={(e) => setPoints((prev) => ({ ...prev, [type]: e.target.value }))}
                style={{ minHeight: 44, padding: '0 12px' }}
              />
            </label>
          ))}
          {saveMutation.error ? (
            <p role="alert" aria-live="assertive">
              {saveMutation.error.message}
            </p>
          ) : null}
          <button type="submit" style={{ minHeight: 44 }}>
            Save rules
          </button>
        </form>
        {saveMutation.data ? (
          <p role="status" style={{ marginTop: 'var(--boxalarm-spacing-sm)' }}>
            Saved as rule version {saveMutation.data.ruleVersionId}.
          </p>
        ) : null}
      </section>
    </main>
  );
}
