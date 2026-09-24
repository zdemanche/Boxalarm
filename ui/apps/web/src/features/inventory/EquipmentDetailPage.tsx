import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  Button,
  Card,
  PageHeader,
  Select,
  Skeleton,
  StatusChip,
  TextInput,
} from '../../components/ui';
import { listApparatus } from '../apparatus/api';
import { listMembers } from '../personnel/api';
import {
  assignEquipmentAsset,
  getEquipmentAsset,
  setEquipmentLocation,
  transitionEquipmentLifecycle,
} from './api';
import type { AssignedToType, LifecycleStatus } from './types';

const NEXT_LIFECYCLE: Record<LifecycleStatus, readonly LifecycleStatus[]> = {
  ACQUIRED: ['IN_SERVICE', 'RETIRED'],
  IN_SERVICE: ['RETIRED'],
  RETIRED: [],
};

export function EquipmentDetailPage() {
  const { assetId = '' } = useParams();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canWrite = auth.roles.includes('ADMIN') || auth.roles.includes('CHIEF');
  const [assignedToType, setAssignedToType] = useState<AssignedToType>('MEMBER');
  const [assignedToId, setAssignedToId] = useState('');
  const [location, setLocation] = useState('');

  const assetQuery = useQuery({
    queryKey: ['inventory', 'equipment', assetId],
    queryFn: () => getEquipmentAsset(auth, assetId),
    enabled: Boolean(assetId),
  });

  const membersQuery = useQuery({
    queryKey: ['personnel', 'members'],
    queryFn: () => listMembers(auth),
    enabled: canWrite && assignedToType === 'MEMBER',
  });

  const apparatusQuery = useQuery({
    queryKey: ['apparatus'],
    queryFn: () => listApparatus(auth),
    enabled: canWrite && assignedToType === 'APPARATUS',
  });

  const assignMutation = useMutation({
    mutationFn: () => assignEquipmentAsset(auth, assetId, assignedToType, assignedToId),
    onSuccess: (asset) => {
      queryClient.setQueryData(['inventory', 'equipment', assetId], asset);
      void queryClient.invalidateQueries({ queryKey: ['inventory', 'equipment'] });
    },
  });

  const locationMutation = useMutation({
    mutationFn: () => setEquipmentLocation(auth, assetId, location),
    onSuccess: (asset) => {
      queryClient.setQueryData(['inventory', 'equipment', assetId], asset);
      void queryClient.invalidateQueries({ queryKey: ['inventory', 'equipment'] });
    },
  });

  const lifecycleMutation = useMutation({
    mutationFn: (target: LifecycleStatus) => transitionEquipmentLifecycle(auth, assetId, target),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        ['inventory', 'equipment', assetId],
        (prev: Awaited<ReturnType<typeof getEquipmentAsset>> | undefined) =>
          prev ? { ...prev, lifecycleStatus: updated.lifecycleStatus } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: ['inventory', 'equipment'] });
    },
  });

  if (assetQuery.error) {
    return (
      <ApiForbiddenGate error={assetQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const asset = assetQuery.data;
  const retired = asset?.lifecycleStatus === 'RETIRED';

  return (
    <main id="main-content">
      <PageHeader
        title={asset?.serialNumber ?? '…'}
        breadcrumbs={[
          { label: 'Inventory', to: '/inventory' },
          { label: asset?.serialNumber ?? '…' },
        ]}
      />
      {assetQuery.isLoading || !asset ? (
        <Skeleton lines={3} />
      ) : (
        <>
          <Card>
            <p role="status">
              <StatusChip status={retired ? 'neutral' : 'ok'}>{asset.lifecycleStatus}</StatusChip>
            </p>
            <dl style={{ margin: 0 }}>
              <dt>Location</dt>
              <dd>{asset.location || '—'}</dd>
              <dt>Assignment</dt>
              <dd>
                {asset.assignedToType
                  ? `${asset.assignedToType} · ${asset.assignedToId}`
                  : 'Unassigned'}
              </dd>
            </dl>
          </Card>

          {canWrite ? (
            <>
              <Card
                title="Assign"
                style={{
                  marginTop: 'var(--bx-space-xl)',
                  maxWidth: 480,
                  opacity: retired ? 0.5 : 1,
                }}
              >
                <form
                  aria-label="Assign asset"
                  onSubmit={(event: FormEvent) => {
                    event.preventDefault();
                    assignMutation.mutate();
                  }}
                  style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
                >
                  <Select
                    label="Assign to"
                    value={assignedToType}
                    disabled={retired}
                    onChange={(e) => {
                      setAssignedToType(e.target.value as AssignedToType);
                      setAssignedToId('');
                    }}
                  >
                    <option value="MEMBER">Member</option>
                    <option value="APPARATUS">Apparatus</option>
                  </Select>
                  <Select
                    label={assignedToType === 'MEMBER' ? 'Member' : 'Apparatus'}
                    value={assignedToId}
                    disabled={retired}
                    required
                    onChange={(e) => setAssignedToId(e.target.value)}
                  >
                    <option value="">
                      {assignedToType === 'MEMBER' ? 'Select a member…' : 'Select an apparatus…'}
                    </option>
                    {assignedToType === 'MEMBER'
                      ? (membersQuery.data ?? []).map((member) => (
                          <option key={member.memberId} value={member.memberId}>
                            {member.firstName} {member.lastName}
                          </option>
                        ))
                      : (apparatusQuery.data ?? []).map((unit) => (
                          <option key={unit.apparatusId} value={unit.apparatusId}>
                            {unit.unitId} · {unit.type}
                          </option>
                        ))}
                  </Select>
                  <Button type="submit" disabled={retired} loading={assignMutation.isPending}>
                    Save assignment
                  </Button>
                  {retired ? <p aria-live="polite">Retired assets cannot be assigned.</p> : null}
                </form>
              </Card>

              <Card title="Location" style={{ marginTop: 'var(--bx-space-xl)', maxWidth: 480 }}>
                <form
                  aria-label="Change location"
                  onSubmit={(event: FormEvent) => {
                    event.preventDefault();
                    locationMutation.mutate();
                  }}
                  style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
                >
                  <TextInput
                    label="New location"
                    value={location}
                    required
                    onChange={(e) => setLocation(e.target.value)}
                  />
                  <Button type="submit" loading={locationMutation.isPending}>
                    Save location
                  </Button>
                </form>
              </Card>

              {NEXT_LIFECYCLE[asset.lifecycleStatus].length > 0 ? (
                <Card title="Lifecycle" style={{ marginTop: 'var(--bx-space-xl)' }}>
                  <div style={{ display: 'flex', gap: 'var(--bx-space-sm)' }}>
                    {NEXT_LIFECYCLE[asset.lifecycleStatus].map((target) => (
                      <Button
                        key={target}
                        type="button"
                        variant="secondary"
                        loading={lifecycleMutation.isPending}
                        onClick={() => lifecycleMutation.mutate(target)}
                      >
                        Move to {target}
                      </Button>
                    ))}
                  </div>
                </Card>
              ) : null}
            </>
          ) : null}

          {assignMutation.error || locationMutation.error || lifecycleMutation.error ? (
            <ApiForbiddenGate
              error={assignMutation.error ?? locationMutation.error ?? lifecycleMutation.error}
              embedded
            >
              <p role="alert">Unable to save changes</p>
            </ApiForbiddenGate>
          ) : null}
        </>
      )}
    </main>
  );
}
