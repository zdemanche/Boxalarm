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
import { hasInspectionsWrite } from './writeRoles';
import styles from './Inspections.module.css';

function coordinatesProblem(latitude: string, longitude: string): string | null {
  if (!latitude && !longitude) return null;
  if (!latitude || !longitude) return 'Enter both latitude and longitude, or leave both empty.';
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return 'Latitude must be between -90 and 90.';
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return 'Longitude must be between -180 and 180.';
  }
  return null;
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function OccupancyListPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canWrite = hasInspectionsWrite(auth.roles);
  const [address, setAddress] = useState('');
  const [occupancyType, setOccupancyType] = useState('');
  const [hazardsText, setHazardsText] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
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
      setLatitude('');
      setLongitude('');
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
      render: (o) => (
        <Link to={`/inspections/occupancies/${o.occupancyId}`} style={{ fontWeight: 600 }}>
          {o.address}
        </Link>
      ),
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

  const table = (
    <DataTable
      caption="Occupancy registry"
      rowKey={(o) => o.occupancyId}
      columns={columns}
      rows={listQuery.data ?? []}
      loading={listQuery.isLoading}
      emptyMessage="No occupancies registered yet."
    />
  );

  return (
    <main id="main-content">
      <PageHeader
        title="Occupancies"
        description="Buildings in the district: what each one is, its hazards and its pre-plan."
      />

      {canWrite ? (
        <div className={styles.layout}>
          {table}
          <Card title="Register occupancy">
            <form
              aria-label="Register occupancy"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                const problem = coordinatesProblem(latitude, longitude);
                if (problem) {
                  setFormError(problem);
                  return;
                }
                createMutation.mutate({
                  address,
                  occupancyType,
                  contacts: [],
                  hazards: splitLines(hazardsText),
                  ...(latitude ? { latitude: Number(latitude), longitude: Number(longitude) } : {}),
                });
              }}
              className={styles.formStack}
            >
              <TextInput
                label="Address"
                help="Include the town for any occupancy outside your department's home area (e.g. 12 Oak St, Monroe). A pre-plan filed without a town is treated as in the home area on dispatches."
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
              <TextInput
                label="Latitude"
                optional
                type="number"
                step="any"
                min={-90}
                max={90}
                inputMode="decimal"
                help="Decimal degrees, e.g. 41.2429. Sets where the building shows on the map and cannot be changed later."
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
              />
              <TextInput
                label="Longitude"
                optional
                type="number"
                step="any"
                min={-180}
                max={180}
                inputMode="decimal"
                help="Decimal degrees, e.g. -73.2007 (west is negative)"
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
              />
              <Textarea
                label="Hazards (one per line)"
                optional
                value={hazardsText}
                onChange={(e) => setHazardsText(e.target.value)}
              />
              {formError ? (
                <p role="alert" aria-live="assertive" className={styles.error}>
                  {formError}
                </p>
              ) : null}
              <div className={styles.formActions}>
                <Button type="submit" loading={createMutation.isPending}>
                  Save occupancy
                </Button>
              </div>
            </form>
          </Card>
        </div>
      ) : (
        table
      )}
    </main>
  );
}
