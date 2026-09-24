import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { createOccupancy, listOccupancies } from './api';
import type { CreateOccupancyInput } from './types';

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function OccupancyListPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canWrite = auth.roles.includes('ADMIN') || auth.roles.includes('CHIEF');
  const [address, setAddress] = useState('');
  const [occupancyType, setOccupancyType] = useState('');
  const [hazardsText, setHazardsText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['inspections', 'occupancies'],
    queryFn: () => listOccupancies(auth),
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateOccupancyInput) => createOccupancy(auth, input),
    onSuccess: async () => {
      setAddress('');
      setOccupancyType('');
      setHazardsText('');
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ['inspections', 'occupancies'] });
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
      <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>Occupancies</h1>

      {listQuery.isLoading ? (
        <p>Loading occupancies…</p>
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
                Address
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Type
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Hazards
              </th>
            </tr>
          </thead>
          <tbody>
            {(listQuery.data ?? []).map((occupancy) => (
              <tr key={occupancy.occupancyId}>
                <th scope="row" style={{ textAlign: 'left', fontWeight: 500 }}>
                  <Link to={`/inspections/occupancies/${occupancy.occupancyId}`}>
                    {occupancy.address}
                  </Link>
                </th>
                <td>{occupancy.occupancyType}</td>
                <td>{occupancy.hazards.length > 0 ? occupancy.hazards.join(', ') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canWrite ? (
        <form
          aria-label="Register occupancy"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            createMutation.mutate({
              address,
              occupancyType,
              contacts: [],
              hazards: splitLines(hazardsText),
            });
          }}
          style={{
            marginTop: 'var(--boxalarm-spacing-xl)',
            display: 'grid',
            gap: 'var(--boxalarm-spacing-md)',
            maxWidth: 480,
          }}
        >
          <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>
            Register occupancy
          </h2>
          <label style={{ display: 'grid', gap: 4 }}>
            Address
            <input
              value={address}
              required
              onChange={(e) => setAddress(e.target.value)}
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            Occupancy type
            <input
              value={occupancyType}
              required
              onChange={(e) => setOccupancyType(e.target.value)}
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            Hazards (one per line, optional)
            <textarea
              value={hazardsText}
              onChange={(e) => setHazardsText(e.target.value)}
              style={{ minHeight: 88, padding: 8 }}
            />
          </label>
          {formError ? (
            <p role="alert" aria-live="assertive">
              {formError}
            </p>
          ) : null}
          <button type="submit" style={{ minHeight: 44 }}>
            Save occupancy
          </button>
        </form>
      ) : null}
    </main>
  );
}
