import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { createApparatus, listApparatus } from './api';
import { serviceStatusRole, StatusBadge } from './StatusBadge';
import type { CreateApparatusInput } from './types';

const emptyForm: CreateApparatusInput = { unitId: '', type: '' };

function formatElapsed(elapsedSeconds: number): string {
  const days = Math.floor(elapsedSeconds / 86400);
  if (days <= 0) return 'today';
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function ApparatusListPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  // §7.1: /apparatus is APPARATUS|CHIEF only — create is the APPARATUS officer action.
  const canCreate = auth.roles.includes('APPARATUS');
  const [form, setForm] = useState<CreateApparatusInput>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['apparatus'],
    queryFn: () => listApparatus(auth),
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateApparatusInput) => createApparatus(auth, input),
    onSuccess: async () => {
      setForm(emptyForm);
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ['apparatus'] });
    },
    onError: (error: Error) => setFormError(error.message),
  });

  if (listQuery.error) {
    return (
      <ApiForbiddenGate error={listQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  return (
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>Apparatus</h1>

      {listQuery.isLoading ? (
        <p>Loading registry…</p>
      ) : (
        <table
          style={{
            width: '100%',
            marginTop: 'var(--boxalarm-spacing-lg)',
            borderCollapse: 'collapse',
          }}
        >
          <thead>
            <tr>
              <th scope="col" style={{ textAlign: 'left' }}>
                Unit ID
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Type
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {(listQuery.data ?? []).map((unit) => (
              <tr key={unit.apparatusId}>
                <th scope="row" style={{ textAlign: 'left', fontWeight: 500 }}>
                  <Link to={`/apparatus/${unit.apparatusId}`}>{unit.unitId}</Link>
                </th>
                <td>{unit.type}</td>
                <td>
                  <StatusBadge
                    role={serviceStatusRole(unit.status)}
                    word={unit.status === 'IN_SERVICE' ? 'In service' : 'Out of service'}
                  />
                  {unit.status === 'OUT_OF_SERVICE' && unit.outOfService ? (
                    <span
                      style={{
                        display: 'block',
                        fontSize: 'var(--boxalarm-font-size-sm)',
                        marginTop: 2,
                      }}
                    >
                      {unit.outOfService.reason} — {formatElapsed(unit.outOfService.elapsedSeconds)}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canCreate ? (
        <form
          aria-label="Create apparatus"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            createMutation.mutate(form);
          }}
          style={{
            marginTop: 'var(--boxalarm-spacing-xl)',
            display: 'grid',
            gap: 'var(--boxalarm-spacing-md)',
            maxWidth: 480,
          }}
        >
          <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>Add apparatus</h2>
          <label style={{ display: 'grid', gap: 4 }}>
            Unit ID
            <input
              name="unitId"
              value={form.unitId}
              required
              onChange={(e) => setForm((prev) => ({ ...prev, unitId: e.target.value }))}
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            Type
            <input
              name="type"
              value={form.type}
              required
              onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value }))}
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          {formError ? (
            <p role="alert" aria-live="assertive">
              {formError}
            </p>
          ) : null}
          <button type="submit" style={{ minHeight: 44 }}>
            Create apparatus
          </button>
        </form>
      ) : null}
    </main>
  );
}
