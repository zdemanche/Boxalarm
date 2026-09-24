import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  Button,
  Card,
  DataTable,
  PageHeader,
  Textarea,
  TextInput,
  type DataTableColumn,
} from '../../components/ui';
import { createOccupancy, listOccupancies } from './api';
import type { CreateOccupancyInput, Occupancy } from './types';

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

  const columns: DataTableColumn<Occupancy>[] = [
    {
      key: 'address',
      header: 'Address',
      sortValue: (o) => o.address,
      render: (o) => <Link to={`/inspections/occupancies/${o.occupancyId}`}>{o.address}</Link>,
    },
    {
      key: 'occupancyType',
      header: 'Type',
      sortValue: (o) => o.occupancyType,
      render: (o) => o.occupancyType,
    },
    {
      key: 'hazards',
      header: 'Hazards',
      render: (o) => (o.hazards.length > 0 ? o.hazards.join(', ') : '—'),
    },
  ];

  return (
    <main id="main-content">
      <PageHeader title="Occupancies" />

      <DataTable
        caption="Occupancy registry"
        rowKey={(o) => o.occupancyId}
        columns={columns}
        rows={listQuery.data ?? []}
        loading={listQuery.isLoading}
        emptyMessage="No occupancies registered yet."
      />

      {canWrite ? (
        <Card title="Register occupancy" style={{ marginTop: 'var(--bx-space-xl)', maxWidth: 480 }}>
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
            style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
          >
            <TextInput
              label="Address"
              value={address}
              required
              onChange={(e) => setAddress(e.target.value)}
            />
            <TextInput
              label="Occupancy type"
              value={occupancyType}
              required
              onChange={(e) => setOccupancyType(e.target.value)}
            />
            <Textarea
              label="Hazards (one per line)"
              optional
              value={hazardsText}
              onChange={(e) => setHazardsText(e.target.value)}
            />
            {formError ? (
              <p role="alert" aria-live="assertive">
                {formError}
              </p>
            ) : null}
            <Button type="submit" loading={createMutation.isPending}>
              Save occupancy
            </Button>
          </form>
        </Card>
      ) : null}
    </main>
  );
}
