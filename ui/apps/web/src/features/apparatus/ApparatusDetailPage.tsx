import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { StatusChip } from '../../components/ui/Chip';
import { PageHeader } from '../../components/ui/PageHeader';
import { Skeleton } from '../../components/ui/Skeleton';
import { getApparatus } from './api';
import { InventoryTab } from './InventoryTab';
import { MaintenanceTab } from './MaintenanceTab';
import { ScbaTab } from './ScbaTab';
import { ServiceStatusControls } from './ServiceStatusControls';
import { TestingTab } from './TestingTab';

const TABS = ['Overview', 'Maintenance', 'SCBA', 'Testing', 'Inventory'] as const;
type Tab = (typeof TABS)[number];

export function ApparatusDetailPage() {
  const { id = '' } = useParams();
  const auth = useAuth();
  const [tab, setTab] = useState<Tab>('Overview');

  const detailQuery = useQuery({
    queryKey: ['apparatus', id],
    queryFn: () => getApparatus(auth, id),
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
        actions={
          unit ? (
            <StatusChip status={unit.status === 'IN_SERVICE' ? 'ok' : 'danger'}>
              {unit.status === 'IN_SERVICE' ? 'In service' : 'Out of service'}
            </StatusChip>
          ) : undefined
        }
      />
      {detailQuery.isLoading || !unit ? (
        <Skeleton lines={3} />
      ) : (
        <>
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'max-content 1fr',
              columnGap: 'var(--bx-space-lg)',
              rowGap: 'var(--bx-space-sm)',
              fontSize: 14,
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
                marginTop: 'var(--boxalarm-spacing-md)',
                color: 'var(--boxalarm-error)',
                fontWeight: 600,
              }}
            >
              Failed tests: {unit.failedTests.map((t) => t.testType).join(', ')}
            </div>
          ) : null}

          <ServiceStatusControls unit={unit} />

          <section style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
            <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)' }}>Open defects</h2>
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
          </section>

          <div
            role="tablist"
            aria-label="Apparatus detail sections"
            style={{
              display: 'flex',
              gap: 'var(--boxalarm-spacing-md)',
              marginTop: 'var(--boxalarm-spacing-lg)',
              borderBottom: '1px solid #0002',
            }}
          >
            {TABS.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={tab === name}
                onClick={() => setTab(name)}
                style={{
                  minHeight: 44,
                  padding: '0 var(--boxalarm-spacing-sm)',
                  background: 'none',
                  border: 'none',
                  borderBottom: tab === name ? '2px solid var(--boxalarm-accent)' : 'none',
                  fontWeight: tab === name ? 700 : 400,
                  cursor: 'pointer',
                  color: 'var(--boxalarm-fg)',
                }}
              >
                {name}
              </button>
            ))}
          </div>

          <div role="tabpanel" style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
            {/* Maintenance/SCBA/Inventory key their sub-resources on apparatusId, matching this
                page's own detail fetch above (getApparatus(auth, id) where id is apparatusId).
                Testing schedules are the one sub-resource the backend resolves and returns by
                display unit code, so it alone still takes unitId — see the tab-identifier note
                in the apparatus-service INFRA reconciliation ticket for the full picture. */}
            {tab === 'Maintenance' ? <MaintenanceTab apparatusId={unit.apparatusId} /> : null}
            {tab === 'SCBA' ? <ScbaTab apparatusId={unit.apparatusId} /> : null}
            {tab === 'Testing' ? <TestingTab unitId={unit.unitId} /> : null}
            {tab === 'Inventory' ? <InventoryTab apparatusId={unit.apparatusId} /> : null}
          </div>
        </>
      )}
    </main>
  );
}
