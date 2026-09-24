import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { createEquipmentAsset, listConsumables, listEquipment } from './api';
import type { CreateEquipmentAssetInput } from './types';

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

  return (
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>Inventory</h1>

      <div
        role="tablist"
        aria-label="Inventory sections"
        style={{
          display: 'flex',
          gap: 'var(--boxalarm-spacing-sm)',
          marginTop: 'var(--boxalarm-spacing-lg)',
        }}
      >
        {(['equipment', 'consumables'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            style={{
              minHeight: 44,
              padding: '0 var(--boxalarm-spacing-md)',
              fontWeight: tab === value ? 700 : 400,
            }}
          >
            {value === 'equipment' ? 'Equipment' : 'Consumables'}
          </button>
        ))}
      </div>

      {tab === 'equipment' ? (
        <section role="tabpanel" aria-label="Equipment">
          <label
            style={{ display: 'inline-flex', gap: 4, marginTop: 'var(--boxalarm-spacing-lg)' }}
          >
            <input
              type="checkbox"
              checked={showRetired}
              onChange={(e) => setShowRetired(e.target.checked)}
            />
            Show retired assets
          </label>

          {equipmentQuery.isLoading ? (
            <p>Loading equipment…</p>
          ) : (
            <table
              style={{
                width: '100%',
                marginTop: 'var(--boxalarm-spacing-md)',
                borderCollapse: 'collapse',
              }}
            >
              <thead>
                <tr>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Serial number
                  </th>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Location
                  </th>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Assignment
                  </th>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Lifecycle
                  </th>
                </tr>
              </thead>
              <tbody>
                {equipment.map((asset) => (
                  <tr key={asset.assetId}>
                    <th scope="row" style={{ textAlign: 'left', fontWeight: 500 }}>
                      <Link to={`/inventory/${asset.assetId}`}>{asset.serialNumber}</Link>
                    </th>
                    <td>{asset.location || '—'}</td>
                    <td>
                      {asset.assignedToType
                        ? `${asset.assignedToType} · ${asset.assignedToId}`
                        : 'Unassigned'}
                    </td>
                    <td>{asset.lifecycleStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {canWrite ? (
            <form
              aria-label="Register equipment"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                createMutation.mutate(form);
              }}
              style={{
                marginTop: 'var(--boxalarm-spacing-xl)',
                display: 'grid',
                gap: 'var(--boxalarm-spacing-md)',
                maxWidth: 480,
              }}
            >
              <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>
                Register equipment
              </h2>
              <label style={{ display: 'grid', gap: 4 }}>
                Serial number
                <input
                  name="serialNumber"
                  value={form.serialNumber}
                  required
                  onChange={(e) => setForm((prev) => ({ ...prev, serialNumber: e.target.value }))}
                  style={{ minHeight: 44, padding: '0 12px' }}
                />
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                Location
                <input
                  name="location"
                  value={form.location}
                  onChange={(e) => setForm((prev) => ({ ...prev, location: e.target.value }))}
                  style={{ minHeight: 44, padding: '0 12px' }}
                />
              </label>
              {formError ? (
                <p role="alert" aria-live="assertive">
                  {formError}
                </p>
              ) : null}
              <button type="submit" style={{ minHeight: 44 }}>
                Register asset
              </button>
            </form>
          ) : null}
        </section>
      ) : (
        <section role="tabpanel" aria-label="Consumables">
          {consumablesQuery.isLoading ? (
            <p>Loading consumables…</p>
          ) : (
            <table
              style={{
                width: '100%',
                marginTop: 'var(--boxalarm-spacing-md)',
                borderCollapse: 'collapse',
              }}
            >
              <thead>
                <tr>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Item
                  </th>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Stock level
                  </th>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Reorder threshold
                  </th>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {(consumablesQuery.data ?? []).map((item) => (
                  <tr key={item.itemId}>
                    <th scope="row" style={{ textAlign: 'left', fontWeight: 500 }}>
                      {item.itemName}
                    </th>
                    <td>{item.stockLevel}</td>
                    <td>{item.reorderThreshold}</td>
                    <td>
                      {item.reorderFlagged ? (
                        <span style={{ color: 'var(--boxalarm-error)' }}>⚠ Reorder needed</span>
                      ) : (
                        'OK'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </main>
  );
}
