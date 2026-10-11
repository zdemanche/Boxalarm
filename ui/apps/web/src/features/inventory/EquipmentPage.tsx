import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { StatusRole } from '@boxalarm/design-tokens';
import { useAuth } from '../../auth/AuthContext';
import { canManageInventory } from '../../auth/roles';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  Button,
  Card,
  Checkbox,
  DataTable,
  PageHeader,
  StatusChip,
  Tabs,
  TextInput,
  type DataTableColumn,
} from '../../components/ui';
import { createEquipmentAsset, listConsumables, listEquipment } from './api';
import { RestockConsumableControl } from './RestockConsumableControl';
import type {
  ConsumableStock,
  CreateEquipmentAssetInput,
  EquipmentAsset,
  LifecycleStatus,
} from './types';
import { humanize } from '../../lib/labels';
import { useAssignmentLabel } from './useAssignmentLabel';
import styles from './Inventory.module.css';

const emptyForm: CreateEquipmentAssetInput = { serialNumber: '', location: '' };

const LIFECYCLE_STATUS: Record<LifecycleStatus, StatusRole> = {
  ACQUIRED: 'info',
  IN_SERVICE: 'ok',
  RETIRED: 'neutral',
};
type Tab = 'equipment' | 'consumables';

export function EquipmentPage() {
  const assignmentLabel = useAssignmentLabel();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canWrite = canManageInventory(auth.roles);
  const [tab, setTab] = useState<Tab>('equipment');
  const [showRetired, setShowRetired] = useState(false);
  const [form, setForm] = useState<CreateEquipmentAssetInput>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  const equipmentQuery = useQuery({
    queryKey: ['inventory', 'equipment'],
    queryFn: () => listEquipment(auth),
    enabled: tab === 'equipment',
  });
  const consumablesQuery = useQuery({
    queryKey: ['inventory', 'consumables'],
    queryFn: () => listConsumables(auth),
    enabled: tab === 'consumables',
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateEquipmentAssetInput) => createEquipmentAsset(auth, input),
    onSuccess: async () => {
      setForm(emptyForm);
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ['inventory', 'equipment'] });
    },
    onError: (error: Error) => setFormError(error.message),
  });

  const activeError = tab === 'equipment' ? equipmentQuery.error : consumablesQuery.error;
  if (activeError) {
    return (
      <ApiForbiddenGate error={activeError}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const allEquipment = equipmentQuery.data ?? [];
  const equipment = allEquipment.filter(
    (asset) => showRetired || asset.lifecycleStatus !== 'RETIRED',
  );
  const hiddenRetired = allEquipment.length - equipment.length;

  const equipmentColumns: DataTableColumn<EquipmentAsset>[] = [
    {
      key: 'serialNumber',
      header: 'Serial number',
      isRowHeader: true,
      sortValue: (a) => a.serialNumber,
      render: (a) => (
        <Link to={`/inventory/${a.assetId}`} className={styles.mono} style={{ fontWeight: 600 }}>
          {a.serialNumber}
        </Link>
      ),
    },
    { key: 'location', header: 'Location', render: (a) => a.location || '—' },
    {
      key: 'assignment',
      header: 'Assignment',
      render: (a) => assignmentLabel(a.assignedToType, a.assignedToId),
    },
    {
      key: 'lifecycleStatus',
      header: 'Lifecycle',
      render: (a) => (
        <StatusChip status={LIFECYCLE_STATUS[a.lifecycleStatus]}>
          {humanize(a.lifecycleStatus)}
        </StatusChip>
      ),
    },
  ];

  const consumableColumns: DataTableColumn<ConsumableStock>[] = [
    {
      key: 'itemName',
      header: 'Item',
      sortValue: (c) => c.itemName,
      render: (c) => (
        <>
          <span style={{ fontWeight: 600 }}>{c.itemName}</span>
          {c.location ? <span className={styles.cellMeta}>{c.location}</span> : null}
        </>
      ),
    },
    {
      key: 'stockLevel',
      header: 'Stock level',
      sortValue: (c) => c.stockLevel,
      render: (c) => c.stockLevel,
    },
    { key: 'reorderThreshold', header: 'Reorder threshold', render: (c) => c.reorderThreshold },
    {
      key: 'status',
      header: 'Status',
      render: (c) =>
        c.reorderFlagged ? (
          <StatusChip status="warning">Reorder needed</StatusChip>
        ) : (
          <StatusChip status="ok">OK</StatusChip>
        ),
    },
    ...(canWrite
      ? [
          {
            key: 'actions',
            header: 'Actions',
            render: (c: ConsumableStock) => <RestockConsumableControl item={c} />,
          } satisfies DataTableColumn<ConsumableStock>,
        ]
      : []),
  ];

  const equipmentTable = (
    <div className={styles.tableWithTools}>
      <div className={styles.tableTools}>
        <p className={styles.tableSummary}>
          {equipmentQuery.isLoading
            ? 'Loading equipment…'
            : `${equipment.length} ${equipment.length === 1 ? 'asset' : 'assets'}${
                hiddenRetired > 0 ? ` · ${hiddenRetired} retired not shown` : ''
              }`}
        </p>
        <Checkbox
          label="Show retired assets"
          checked={showRetired}
          onCheckedChange={setShowRetired}
        />
      </div>
      <DataTable
        caption="Equipment"
        rowKey={(a) => a.assetId}
        columns={equipmentColumns}
        rows={equipment}
        loading={equipmentQuery.isLoading}
        emptyMessage="No equipment registered yet."
      />
    </div>
  );

  return (
    <main id="main-content">
      <PageHeader
        title="Inventory"
        description="Department equipment and consumable stock: where each item is and what to reorder."
      />

      <Tabs
        label="Inventory sections"
        value={tab}
        onValueChange={(value) => setTab(value as Tab)}
        items={[
          {
            value: 'equipment',
            label: 'Equipment',
            content: canWrite ? (
              <div className={styles.layout}>
                {equipmentTable}
                <Card title="Register equipment">
                  <form
                    aria-label="Register equipment"
                    onSubmit={(event: FormEvent) => {
                      event.preventDefault();
                      createMutation.mutate(form);
                    }}
                    className={styles.formGrid}
                  >
                    <TextInput
                      label="Serial number"
                      name="serialNumber"
                      value={form.serialNumber}
                      required
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, serialNumber: e.target.value }))
                      }
                    />
                    <TextInput
                      label="Location"
                      name="location"
                      optional
                      value={form.location}
                      onChange={(e) => setForm((prev) => ({ ...prev, location: e.target.value }))}
                    />
                    {formError ? (
                      <p role="alert" aria-live="assertive" className={styles.error}>
                        {formError}
                      </p>
                    ) : null}
                    <div className={styles.formActions}>
                      <Button type="submit" loading={createMutation.isPending}>
                        Register asset
                      </Button>
                    </div>
                  </form>
                </Card>
              </div>
            ) : (
              equipmentTable
            ),
          },
          {
            value: 'consumables',
            label: 'Consumables',
            content: (
              <DataTable
                caption="Consumables"
                rowKey={(c) => c.itemId}
                columns={consumableColumns}
                rows={consumablesQuery.data ?? []}
                loading={consumablesQuery.isLoading}
                emptyMessage="No consumables tracked yet."
              />
            ),
          },
        ]}
      />
    </main>
  );
}
