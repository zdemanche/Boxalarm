import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { canManageInventory } from '../../auth/roles';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { AuditHistoryLink } from '../../components/AuditHistoryLink';
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
import { humanize } from '../../lib/labels';
import { useAssignmentLabel } from './useAssignmentLabel';
import styles from './Inventory.module.css';

const NEXT_LIFECYCLE: Record<LifecycleStatus, readonly LifecycleStatus[]> = {
  ACQUIRED: ['IN_SERVICE', 'RETIRED'],
  IN_SERVICE: ['RETIRED'],
  RETIRED: [],
};

export function EquipmentDetailPage() {
  const { assetId = '' } = useParams();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canWrite = canManageInventory(auth.roles);
  const [assignedToType, setAssignedToType] = useState<AssignedToType>('MEMBER');
  const [assignedToId, setAssignedToId] = useState('');
  const [location, setLocation] = useState('');

  const assignmentLabel = useAssignmentLabel();

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
  const saveError = assignMutation.error ?? locationMutation.error ?? lifecycleMutation.error;

  return (
    <main id="main-content">
      <PageHeader
        title={asset?.serialNumber ?? '…'}
        breadcrumbs={[
          { label: 'Inventory', to: '/inventory' },
          { label: asset?.serialNumber ?? '…' },
        ]}
        description={
          asset ? (
            <span className={styles.headerMeta}>
              <span role="status">
                <StatusChip status={retired ? 'neutral' : 'ok'}>
                  {humanize(asset.lifecycleStatus)}
                </StatusChip>
              </span>
              <span>Equipment asset</span>
            </span>
          ) : undefined
        }
        actions={
          asset ? (
            <AuditHistoryLink entityType="EQUIPMENT_ASSET" entityId={asset.assetId} />
          ) : undefined
        }
      />
      {assetQuery.isLoading || !asset ? (
        <Card>
          <Skeleton lines={3} />
        </Card>
      ) : (
        <div className={styles.stack}>
          {saveError ? (
            <ApiForbiddenGate error={saveError} embedded>
              <p role="alert">Unable to save changes</p>
            </ApiForbiddenGate>
          ) : null}

          <div className={canWrite ? styles.layout : styles.stack}>
            <div className={styles.stack}>
              <Card title="Details">
                <dl className={styles.facts}>
                  <dt>Location</dt>
                  <dd>{asset.location || '—'}</dd>
                  <dt>Assigned to</dt>
                  <dd>{assignmentLabel(asset.assignedToType, asset.assignedToId)}</dd>
                </dl>
              </Card>

              {canWrite ? (
                <Card title="Assign">
                  <form
                    aria-label="Assign asset"
                    onSubmit={(event: FormEvent) => {
                      event.preventDefault();
                      assignMutation.mutate();
                    }}
                    className={styles.formGrid}
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
                    {retired ? (
                      <p aria-live="polite" className={styles.message}>
                        Retired assets cannot be assigned.
                      </p>
                    ) : null}
                    <div className={styles.formActions}>
                      <Button type="submit" disabled={retired} loading={assignMutation.isPending}>
                        Save assignment
                      </Button>
                    </div>
                  </form>
                </Card>
              ) : null}
            </div>

            {canWrite ? (
              <div className={styles.stack}>
                <Card title="Change location">
                  <form
                    aria-label="Change location"
                    onSubmit={(event: FormEvent) => {
                      event.preventDefault();
                      locationMutation.mutate();
                    }}
                    className={styles.formGrid}
                  >
                    <TextInput
                      label="New location"
                      value={location}
                      required
                      onChange={(e) => setLocation(e.target.value)}
                    />
                    <div className={styles.formActions}>
                      <Button
                        type="submit"
                        variant="secondary"
                        loading={locationMutation.isPending}
                      >
                        Save location
                      </Button>
                    </div>
                  </form>
                </Card>

                {NEXT_LIFECYCLE[asset.lifecycleStatus].length > 0 ? (
                  <Card title="Lifecycle">
                    <p className={styles.cardIntro}>
                      {asset.lifecycleStatus === 'ACQUIRED'
                        ? 'Put it in service once it is checked and issued, or retire it.'
                        : 'Retire it when it leaves the fleet. A retired asset cannot be assigned.'}
                    </p>
                    <div className={styles.lifecycleActions}>
                      {NEXT_LIFECYCLE[asset.lifecycleStatus].map((target) => (
                        <Button
                          key={target}
                          type="button"
                          variant="secondary"
                          loading={lifecycleMutation.isPending}
                          onClick={() => lifecycleMutation.mutate(target)}
                        >
                          Move to {humanize(target)}
                        </Button>
                      ))}
                    </div>
                  </Card>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </main>
  );
}
