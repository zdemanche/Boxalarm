import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  Button,
  Card,
  Checkbox,
  DataTable,
  PageHeader,
  Skeleton,
  StatusChip,
  Tabs,
  TextInput,
  type DataTableColumn,
} from '../../components/ui';
import { createEquipmentAsset, listConsumables, listEquipment } from './api';
import type { ConsumableStock, CreateEquipmentAssetInput, EquipmentAsset } from './types';

const emptyForm: CreateEquipmentAssetInput = { serialNumber: '', location: '' };
type Tab = 'equipment' | 'consumables';

export function EquipmentPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canWrite = auth.roles.includes('ADMIN') || auth.roles.includes('CHIEF');
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

  const equipment = (equipmentQuery.data ?? []).filter(
    (asset) => showRetired || asset.lifecycleStatus !== 'RETIRED',
  );

  const equipmentColumns: DataTableColumn<EquipmentAsset>[] = [
    {
      key: 'serialNumber',
      header: 'Serial number',
      sortValue: (a) => a.serialNumber,
      render: (a) => <Link to={`/inventory/${a.assetId}`}>{a.serialNumber}</Link>,
    },
    { key: 'location', header: 'Location', render: (a) => a.location || '—' },
    {
      key: 'assignment',
      header: 'Assignment',
      render: (a) => (a.assignedToType ? `${a.assignedToType} · ${a.assignedToId}` : 'Unassigned'),
    },
    { key: 'lifecycleStatus', header: 'Lifecycle', render: (a) => a.lifecycleStatus },
  ];

  const consumableColumns: DataTableColumn<ConsumableStock>[] = [
    { key: 'itemName', header: 'Item', sortValue: (c) => c.itemName, render: (c) => c.itemName },
    { key: 'stockLevel', header: 'Stock level', render: (c) => c.stockLevel },
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
  ];

  return (
    <main id="main-content">
      <PageHeader title="Inventory" />

      <Tabs
        label="Inventory sections"
        value={tab}
        onValueChange={(value) => setTab(value as Tab)}
        items={[
          {
            value: 'equipment',
            label: 'Equipment',
            content: (
              <>
                <Checkbox
                  label="Show retired assets"
                  checked={showRetired}
                  onCheckedChange={setShowRetired}
                />

                {equipmentQuery.isLoading ? (
                  <Skeleton lines={4} />
                ) : (
                  <DataTable
                    caption="Equipment"
                    rowKey={(a) => a.assetId}
                    columns={equipmentColumns}
                    rows={equipment}
                    emptyMessage="No equipment registered yet."
                  />
                )}

                {canWrite ? (
                  <Card
                    title="Register equipment"
                    style={{ marginTop: 'var(--bx-space-xl)', maxWidth: 480 }}
                  >
                    <form
                      aria-label="Register equipment"
                      onSubmit={(event: FormEvent) => {
                        event.preventDefault();
                        createMutation.mutate(form);
                      }}
                      style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
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
                        <p role="alert" aria-live="assertive">
                          {formError}
                        </p>
                      ) : null}
                      <Button type="submit" loading={createMutation.isPending}>
                        Register asset
                      </Button>
                    </form>
                  </Card>
                ) : null}
              </>
            ),
          },
          {
            value: 'consumables',
            label: 'Consumables',
            content: consumablesQuery.isLoading ? (
              <Skeleton lines={4} />
            ) : (
              <DataTable
                caption="Consumables"
                rowKey={(c) => c.itemId}
                columns={consumableColumns}
                rows={consumablesQuery.data ?? []}
                emptyMessage="No consumables tracked yet."
              />
            ),
          },
        ]}
      />
    </main>
  );
}
