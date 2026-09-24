import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { createInventoryItem, getInventory, updateInventoryQuantity } from './api';
import type { CreateInventoryItemInput } from './types';

const emptyForm: CreateInventoryItemInput = { compartmentCode: '', itemName: '', quantity: 1 };

// Takes the apparatus's apparatusId (not its display unitId) — matches ApparatusDetailPage's
// own detail fetch and the real backend's inventory endpoints, which key directly on
// apparatusId (apparatus-service inventory/compartmentItemRepository.ts).
export function InventoryTab({ apparatusId }: { apparatusId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(emptyForm);

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
      void queryClient.invalidateQueries({ queryKey: ['apparatus', apparatusId, 'inventory'] });
    },
  });

  if (query.error) {
    return (
      <ApiForbiddenGate error={query.error} embedded>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  return (
    <section>
      <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)' }}>Compartment inventory</h2>
      {query.isLoading ? (
        <p>Loading inventory…</p>
      ) : (query.data ?? []).length === 0 ? (
        <p>No inventory recorded for this unit.</p>
      ) : (
        (query.data ?? []).map((group) => (
          <div key={group.compartmentCode} style={{ marginTop: 'var(--boxalarm-spacing-md)' }}>
            <h3 style={{ fontSize: 'var(--boxalarm-font-size-base)' }}>{group.compartmentCode}</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Item
                  </th>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Quantity
                  </th>
                </tr>
              </thead>
              <tbody>
                {group.items.map((item) => (
                  <tr key={item.itemId}>
                    <th scope="row" style={{ textAlign: 'left', fontWeight: 400 }}>
                      {item.itemName}
                    </th>
                    <td>
                      <label>
                        <span className="visually-hidden">Quantity for {item.itemName}</span>
                        <input
                          type="number"
                          min="0"
                          defaultValue={item.quantity}
                          style={{ minHeight: 44, width: 80 }}
                          onBlur={(e) => {
                            const quantity = Number(e.target.value);
                            if (Number.isInteger(quantity) && quantity !== item.quantity) {
                              quantityMutation.mutate({ itemId: item.itemId, quantity });
                            }
                          }}
                        />
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      <form
        aria-label="Add inventory item"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          createMutation.mutate(form);
        }}
        style={{
          display: 'grid',
          gap: 'var(--boxalarm-spacing-sm)',
          maxWidth: 480,
          marginTop: 'var(--boxalarm-spacing-lg)',
        }}
      >
        <h3 style={{ fontSize: 'var(--boxalarm-font-size-base)', margin: 0 }}>Add item</h3>
        <label style={{ display: 'grid', gap: 4 }}>
          Compartment
          <input
            value={form.compartmentCode}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, compartmentCode: e.target.value }))}
            style={{ minHeight: 44, padding: '0 12px' }}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          Item name
          <input
            value={form.itemName}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, itemName: e.target.value }))}
            style={{ minHeight: 44, padding: '0 12px' }}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          Quantity
          <input
            type="number"
            min="0"
            value={form.quantity}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, quantity: Number(e.target.value) }))}
            style={{ minHeight: 44, padding: '0 12px' }}
          />
        </label>
        {createMutation.error ? <p role="alert">{createMutation.error.message}</p> : null}
        <button type="submit" style={{ minHeight: 44, maxWidth: 240 }}>
          Add item
        </button>
      </form>
    </section>
  );
}
