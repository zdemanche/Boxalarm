import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Card, PageHeader, Skeleton, Tabs } from '../../components/ui';
import { listEquipment } from '../inventory/api';
import { getApparatus } from './api';
import { InventoryTab } from './InventoryTab';
import { MaintenanceTab } from './MaintenanceTab';
import { ScbaTab } from './ScbaTab';
import { ServiceStatusControls } from './ServiceStatusControls';
import { TestingTab } from './TestingTab';

export function ApparatusDetailPage() {
  const { id = '' } = useParams();
  const auth = useAuth();

  const detailQuery = useQuery({
    queryKey: ['apparatus', id],
    queryFn: () => getApparatus(auth, id),
    enabled: Boolean(id),
  });

  const equipmentQuery = useQuery({
    queryKey: ['inventory', 'equipment', 'byApparatus', id],
    queryFn: () => listEquipment(auth, { assignedToType: 'APPARATUS', assignedToId: id }),
    enabled: Boolean(id),
  });

  if (detailQuery.error) {
    return (
      <ApiForbiddenGate error={detailQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const unit = detailQuery.data;

  return (
    <main id="main-content">
      <PageHeader
        title={unit?.unitId ?? '…'}
        breadcrumbs={[{ label: 'Apparatus', to: '/apparatus' }, { label: unit?.unitId ?? '…' }]}
      />
      {detailQuery.isLoading || !unit ? (
        <Skeleton lines={3} />
      ) : (
        <>
          <Card>
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: 'max-content 1fr',
                columnGap: 'var(--bx-space-lg)',
                rowGap: 'var(--bx-space-sm)',
                fontSize: 14,
                margin: 0,
              }}
            >
              <dt style={{ color: 'var(--bx-fg-muted)' }}>Type</dt>
              <dd style={{ margin: 0 }}>{unit.type}</dd>
              <dt style={{ color: 'var(--bx-fg-muted)' }}>Apparatus ID</dt>
              <dd style={{ margin: 0, fontFamily: 'var(--bx-font-mono)' }}>{unit.apparatusId}</dd>
            </dl>
            {unit.failedTests.length > 0 ? (
              <div
                role="alert"
                style={{
                  marginTop: 'var(--bx-space-md)',
                  color: 'var(--bx-status-danger)',
                  fontWeight: 600,
                }}
              >
                Failed tests: {unit.failedTests.map((t) => t.testType).join(', ')}
              </div>
            ) : null}
          </Card>

          <ServiceStatusControls unit={unit} />

          <Card title="Open defects">
            {unit.openDefects.length === 0 ? (
              <p>No open defects.</p>
            ) : (
              <ul>
                {unit.openDefects.map((defect) => (
                  <li key={defect.defectId}>
                    {defect.description} — {defect.severity} —{' '}
                    {new Date(defect.reportedAt * 1000).toLocaleDateString()}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Tabs
            label="Apparatus detail sections"
            items={[
              {
                value: 'maintenance',
                label: 'Maintenance',
                content: <MaintenanceTab apparatusId={unit.apparatusId} />,
              },
              {
                value: 'scba',
                label: 'SCBA',
                content: <ScbaTab apparatusId={unit.apparatusId} />,
              },
              {
                // Testing schedules are the one sub-resource the backend resolves and returns by
                // display unit code, so it alone still takes unitId — see the tab-identifier note
                // in the apparatus-service INFRA reconciliation ticket for the full picture.
                value: 'testing',
                label: 'Testing',
                content: <TestingTab unitId={unit.unitId} />,
              },
              {
                value: 'inventory',
                label: 'Inventory',
                content: <InventoryTab apparatusId={unit.apparatusId} />,
              },
            ]}
          />

          <Card title="Assigned equipment">
            {equipmentQuery.isLoading ? (
              <Skeleton lines={2} />
            ) : (equipmentQuery.data ?? []).length === 0 ? (
              <p>No equipment assigned.</p>
            ) : (
              <ul>
                {(equipmentQuery.data ?? []).map((asset) => (
                  <li key={asset.assetId}>
                    <Link to={`/inventory/${asset.assetId}`}>{asset.serialNumber}</Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </main>
  );
}
