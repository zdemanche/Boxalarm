import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
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
  const isAdmin = auth.roles.includes('ADMIN');
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
    enabled: isAdmin && assignedToType === 'MEMBER',
  });

  const apparatusQuery = useQuery({
    queryKey: ['apparatus'],
    queryFn: () => listApparatus(auth),
    enabled: isAdmin && assignedToType === 'APPARATUS',
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
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      <p>
        <Link to="/inventory">← Inventory</Link>
      </p>
      {assetQuery.isLoading || !asset ? (
        <p>Loading asset…</p>
      ) : (
        <>
          <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>
            {asset.serialNumber}
          </h1>
          <p
            role="status"
            style={{
              marginTop: 'var(--boxalarm-spacing-md)',
              fontSize: 'var(--boxalarm-font-size-lg)',
            }}
          >
            {asset.lifecycleStatus}
          </p>

          <dl style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
            <dt>Location</dt>
            <dd>{asset.location || '—'}</dd>
            <dt>Assignment</dt>
            <dd>
              {asset.assignedToType
                ? `${asset.assignedToType} · ${asset.assignedToId}`
                : 'Unassigned'}
            </dd>
          </dl>

          {isAdmin ? (
            <>
              <form
                aria-label="Assign asset"
                onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  assignMutation.mutate();
                }}
                style={{
                  marginTop: 'var(--boxalarm-spacing-xl)',
                  display: 'grid',
                  gap: 'var(--boxalarm-spacing-md)',
                  maxWidth: 480,
                  opacity: retired ? 0.5 : 1,
                }}
              >
                <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>Assign</h2>
                <label style={{ display: 'grid', gap: 4 }}>
                  Assign to
                  <select
                    value={assignedToType}
                    disabled={retired}
                    onChange={(e) => {
                      setAssignedToType(e.target.value as AssignedToType);
                      setAssignedToId('');
                    }}
                    style={{ minHeight: 44 }}
                  >
                    <option value="MEMBER">Member</option>
                    <option value="APPARATUS">Apparatus</option>
                  </select>
                </label>
                <label style={{ display: 'grid', gap: 4 }}>
                  {assignedToType === 'MEMBER' ? 'Member' : 'Apparatus'}
                  <select
                    value={assignedToId}
                    disabled={retired}
                    required
                    onChange={(e) => setAssignedToId(e.target.value)}
                    style={{ minHeight: 44 }}
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
                  </select>
                </label>
                <button type="submit" disabled={retired} style={{ minHeight: 44 }}>
                  Save assignment
                </button>
                {retired ? <p aria-live="polite">Retired assets cannot be assigned.</p> : null}
              </form>

              <form
                aria-label="Change location"
                onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  locationMutation.mutate();
                }}
                style={{
                  marginTop: 'var(--boxalarm-spacing-xl)',
                  display: 'grid',
                  gap: 'var(--boxalarm-spacing-md)',
                  maxWidth: 480,
                }}
              >
                <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>Location</h2>
                <label style={{ display: 'grid', gap: 4 }}>
                  New location
                  <input
                    value={location}
                    required
                    onChange={(e) => setLocation(e.target.value)}
                    style={{ minHeight: 44, padding: '0 12px' }}
                  />
                </label>
                <button type="submit" style={{ minHeight: 44 }}>
                  Save location
                </button>
              </form>

              {NEXT_LIFECYCLE[asset.lifecycleStatus].length > 0 ? (
                <div style={{ marginTop: 'var(--boxalarm-spacing-xl)' }}>
                  <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>Lifecycle</h2>
                  <div
                    style={{
                      display: 'flex',
                      gap: 'var(--boxalarm-spacing-sm)',
                      marginTop: 'var(--boxalarm-spacing-md)',
                    }}
                  >
                    {NEXT_LIFECYCLE[asset.lifecycleStatus].map((target) => (
                      <button
                        key={target}
                        type="button"
                        disabled={lifecycleMutation.isPending}
                        onClick={() => lifecycleMutation.mutate(target)}
                        style={{ minHeight: 44 }}
                      >
                        Move to {target}
                      </button>
                    ))}
                  </div>
                </div>
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
