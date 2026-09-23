import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
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
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      <p>
        <Link to="/apparatus">← Apparatus</Link>
      </p>
      {detailQuery.isLoading || !unit ? (
        <p>Loading apparatus…</p>
      ) : (
        <>
          <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>{unit.unitId}</h1>
          <p
            role="status"
            style={{
              marginTop: 'var(--boxalarm-spacing-md)',
              fontSize: 'var(--boxalarm-font-size-lg)',
            }}
          >
            {unit.status === 'IN_SERVICE' ? 'In service' : 'Out of service'}
          </p>
          <dl style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
            <dt>Type</dt>
            <dd>{unit.type}</dd>
            <dt>Apparatus ID</dt>
            <dd>{unit.apparatusId}</dd>
          </dl>
        </>
      )}
    </main>
  );
}
