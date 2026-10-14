import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, DataTable, TextInput, type DataTableColumn } from '../../components/ui';
import { createInventoryItem, getInventory, updateInventoryQuantity } from './api';
import type { CompartmentItem, CreateInventoryItemInput } from './types';
import styles from './Apparatus.module.css';

const emptyForm: CreateInventoryItemInput = { compartmentCode: '', itemName: '', quantity: 1 };

type CompartmentRow = CompartmentItem & { compartmentCode: string };

// Takes the apparatus's apparatusId (not its display unitId) — matches ApparatusDetailPage's
// own detail fetch and the real backend's inventory endpoints, which key directly on
// apparatusId (apparatus-service inventory/compartmentItemRepository.ts).
export function InventoryTab({ apparatusId }: { apparatusId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(emptyForm);
  const [quantityError, setQuantityError] = useState<{ itemId: string; message: string } | null>(
    null,
  );
  // Bumped on a failed save so the uncontrolled quantity input remounts with the last
  // persisted value instead of keeping the unsaved number on screen.
  const [quantityResetNonce, setQuantityResetNonce] = useState(0);

  const query = useQuery({
    queryKey: ['apparatus', apparatusId, 'inventory'],
    queryFn: () => getInventory(auth, apparatusId),
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateInventoryItemInput) => createInventoryItem(auth, apparatusId, input),
    onSuccess: () => {
      setForm(emptyForm);
      void queryClient.invalidateQueries({ queryKey: ['apparatus', apparatusId, 'inventory'] });
    },
  });

  const quantityMutation = useMutation({
    mutationFn: (input: { itemId: string; quantity: number }) =>
      updateInventoryQuantity(auth, apparatusId, input.itemId, input.quantity),
    onSuccess: () => {
      setQuantityError(null);
      void queryClient.invalidateQueries({ queryKey: ['apparatus', apparatusId, 'inventory'] });
    },
    onError: (error: Error, input) => {
      setQuantityError({
        itemId: input.itemId,
        message: `Quantity not saved: ${error.message}`,
      });
      setQuantityResetNonce((n) => n + 1);
    },
  });

  if (query.error) {
    return (
      <Card>
        <ApiForbiddenGate error={query.error} embedded>
          <p>Unexpected error</p>
        </ApiForbiddenGate>
      </Card>
    );
  }

  // One table for the whole unit, compartment by compartment: a card per compartment put a
  // bordered table inside a bordered card for every one of them.
  const rows: CompartmentRow[] = (query.data ?? []).flatMap((group) =>
    group.items.map((item) => ({ ...item, compartmentCode: group.compartmentCode })),
  );

  const columns: DataTableColumn<CompartmentRow>[] = [
    {
      key: 'compartmentCode',
      header: 'Compartment',
      sortValue: (i) => i.compartmentCode,
      render: (i) => <span className={styles.mono}>{i.compartmentCode}</span>,
    },
    { key: 'itemName', header: 'Item', sortValue: (i) => i.itemName, render: (i) => i.itemName },
    {
      key: 'quantity',
      header: 'Quantity',
      sortValue: (i) => i.quantity,
      render: (i) => (
        <span className={styles.quantityCell}>
          <TextInput
            key={`${i.itemId}-${quantityResetNonce}`}
            label={`Quantity for ${i.itemName}`}
            type="number"
            min="0"
            defaultValue={i.quantity}
            error={quantityError?.itemId === i.itemId ? quantityError.message : undefined}
            onBlur={(e) => {
              const quantity = Number(e.target.value);
              if (Number.isInteger(quantity) && quantity !== i.quantity) {
                quantityMutation.mutate({ itemId: i.itemId, quantity });
              }
            }}
          />
        </span>
      ),
    },
  ];

  return (
    <div className={styles.stack}>
      <DataTable
        caption="Compartment inventory"
        rowKey={(i) => i.itemId}
        columns={columns}
        rows={rows}
        loading={query.isLoading}
        emptyMessage="No inventory recorded for this unit."
      />

      <Card title="Add item">
        <form
          aria-label="Add inventory item"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            createMutation.mutate(form);
          }}
          className={styles.formGrid}
        >
          <TextInput
            label="Compartment"
            value={form.compartmentCode}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, compartmentCode: e.target.value }))}
          />
          <TextInput
            label="Item name"
            value={form.itemName}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, itemName: e.target.value }))}
          />
          <TextInput
            label="Quantity"
            type="number"
            min="0"
            value={form.quantity}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, quantity: Number(e.target.value) }))}
          />
          {createMutation.error ? (
            <p role="alert" className={styles.error}>
              {createMutation.error.message}
            </p>
          ) : null}
          <div className={styles.formActions}>
            <Button type="submit" loading={createMutation.isPending}>
              Add item
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
