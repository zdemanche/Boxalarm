import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { getAuditTrail } from './api';
import type { AuditEntry } from './types';

interface Query {
  entityType: string;
  entityId: string;
}

export function AuditLogPage() {
  const auth = useAuth();
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [submitted, setSubmitted] = useState<Query | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [entries, setEntries] = useState<AuditEntry[]>([]);

  const auditQuery = useQuery({
    queryKey: ['platform', 'audit', submitted?.entityType, submitted?.entityId, cursor],
    queryFn: () => getAuditTrail(auth, submitted!.entityType, submitted!.entityId, cursor),
    enabled: submitted !== null,
  });

  useEffect(() => {
    if (!auditQuery.data) return;
    setEntries((prev) =>
      cursor ? [...prev, ...auditQuery.data.entries] : auditQuery.data.entries,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditQuery.data]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setCursor(undefined);
    setEntries([]);
    setSubmitted({ entityType, entityId });
  }

  const error = auditQuery.error;
  const validationDetail =
    error instanceof ApiError && error.problem.status === 400 ? error.problem.detail : null;

  return (
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>Audit log</h1>
      <form
        aria-label="Look up audit history"
        onSubmit={handleSubmit}
        style={{
          display: 'grid',
          gap: 'var(--boxalarm-spacing-md)',
          maxWidth: 480,
          marginTop: 'var(--boxalarm-spacing-lg)',
        }}
      >
        <label style={{ display: 'grid', gap: 4 }}>
          Entity type
          <input
            value={entityType}
            required
            onChange={(e) => setEntityType(e.target.value)}
            style={{ minHeight: 44, padding: '0 12px' }}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          Entity ID
          <input
            value={entityId}
            required
            onChange={(e) => setEntityId(e.target.value)}
            style={{ minHeight: 44, padding: '0 12px' }}
          />
        </label>
        {validationDetail ? (
          <p role="alert" aria-live="assertive">
            {validationDetail}
          </p>
        ) : null}
        <button type="submit" style={{ minHeight: 44, width: 'fit-content' }}>
          Look up
        </button>
      </form>

      {submitted ? (
        auditQuery.isLoading && entries.length === 0 ? (
          <p>Loading history…</p>
        ) : error && !validationDetail ? (
          <ApiForbiddenGate error={error}>
            <p>Unexpected error</p>
          </ApiForbiddenGate>
        ) : entries.length === 0 && !validationDetail ? (
          <p>No change history for this record.</p>
        ) : entries.length > 0 ? (
          <>
            <table
              style={{
                width: '100%',
                marginTop: 'var(--boxalarm-spacing-lg)',
                borderCollapse: 'collapse',
              }}
            >
              <thead>
                <tr>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Timestamp
                  </th>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Actor
                  </th>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Action
                  </th>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Changed fields
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={`${entry.ts}-${entry.actorId}`}>
                    <td>{new Date(entry.ts).toLocaleString()}</td>
                    <td>{entry.actorId}</td>
                    <td>{entry.action}</td>
                    <td>
                      {Object.keys(entry.changedFields).length === 0 ? (
                        '—'
                      ) : (
                        <ul style={{ margin: 0, paddingLeft: 'var(--boxalarm-spacing-md)' }}>
                          {Object.entries(entry.changedFields).map(([field, diff]) => {
                            const { old: oldValue, new: newValue } = diff as {
                              old: unknown;
                              new: unknown;
                            };
                            return (
                              <li key={field}>
                                {field}: {JSON.stringify(oldValue)} → {JSON.stringify(newValue)}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {auditQuery.data?.nextCursor ? (
              <button
                type="button"
                onClick={() => setCursor(auditQuery.data?.nextCursor)}
                style={{ minHeight: 44, marginTop: 'var(--boxalarm-spacing-md)' }}
              >
                Load more
              </button>
            ) : null}
          </>
        ) : null
      ) : null}
    </main>
  );
}
