import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { StatusChip } from '../../components/ui/Chip';
import { PageHeader } from '../../components/ui/PageHeader';
import { Skeleton } from '../../components/ui/Skeleton';
import { getApparatus } from './api';

export function ApparatusDetailPage() {
  const { id = '' } = useParams();
  const auth = useAuth();

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
      )}
    </main>
  );
}
