import { FormEvent, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { canManageInventory } from '../../auth/roles';
import { Button, TextInput } from '../../components/ui';
import { restockConsumable } from './api';
import type { ConsumableStock } from './types';

/**
 * Clears the reorder flag by setting a new stock level (#131, N-9: last-writer-wins, same
 * chief/admin/officer tier as the rest of inventory's writes). Lives in the consumable's own
 * row, same inline open/submit/cancel shape as apparatus's ResolveDefectControl - closes and
 * resets on success, so the next open starts blank rather than showing a stale number.
 */
export function RestockConsumableControl({ item }: { item: ConsumableStock }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [stockLevel, setStockLevel] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (newStockLevel: number) =>
      restockConsumable(auth, item.itemId, { stockLevel: newStockLevel }),
    onSuccess: () => {
      setOpen(false);
      setStockLevel('');
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['inventory', 'consumables'] });
    },
    onError: (error: Error) => setFormError(error.message),
  });

  if (!canManageInventory(auth.roles)) {
    return null;
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="secondary"
        onClick={() => setOpen(true)}
        aria-label={`Restock ${item.itemName}`}
      >
        Restock
      </Button>
    );
  }

  return (
    <form
      aria-label={`Restock ${item.itemName}`}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        const parsed = Number(stockLevel);
        if (stockLevel.trim().length === 0 || !Number.isFinite(parsed) || parsed < 0) {
          setFormError('Enter the new stock level as a non-negative number.');
          return;
        }
        mutation.mutate(parsed);
      }}
      style={{ display: 'flex', gap: 'var(--bx-space-sm)', alignItems: 'flex-end' }}
    >
      <TextInput
        label="New stock level"
        type="number"
        min={0}
        value={stockLevel}
        onChange={(e) => setStockLevel(e.target.value)}
        error={formError ?? undefined}
      />
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Saving…' : 'Save'}
      </Button>
      <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}
