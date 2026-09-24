import { useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  Button,
  Card,
  DataTable,
  PageHeader,
  TextInput,
  type DataTableColumn,
} from '../../components/ui';
import { getAuditTrail } from './api';
import type { AuditEntry } from './types';

interface Query {
  entityType: string;
  entityId: string;
  /** Bumped on every submit, including a resubmit of the same lookup, so the query key
   * always changes and a fresh fetch always fires — same entityType/entityId would
   * otherwise be an unchanged key that useQuery/useInfiniteQuery has no reason to refetch. */
  nonce: number;
}

export function AuditLogPage() {
  const auth = useAuth();
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [submitted, setSubmitted] = useState<Query | null>(null);
  const nextNonce = useRef(0);

  const auditQuery = useInfiniteQuery({
    queryKey: ['platform', 'audit', submitted?.entityType, submitted?.entityId, submitted?.nonce],
    queryFn: ({ pageParam }) =>
      getAuditTrail(auth, submitted!.entityType, submitted!.entityId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: submitted !== null,
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    nextNonce.current += 1;
    setSubmitted({ entityType, entityId, nonce: nextNonce.current });
  }

  const entries = auditQuery.data?.pages.flatMap((page) => page.entries) ?? [];
  const nextCursor = auditQuery.data?.pages.at(-1)?.nextCursor;

  const error = auditQuery.error;
  const validationDetail =
    error instanceof ApiError && error.problem.status === 400 ? error.problem.detail : null;

  const columns: DataTableColumn<AuditEntry>[] = [
    { key: 'ts', header: 'Timestamp', render: (e) => new Date(e.ts).toLocaleString() },
    { key: 'actorId', header: 'Actor', render: (e) => e.actorId },
    { key: 'action', header: 'Action', render: (e) => e.action },
    {
      key: 'changedFields',
      header: 'Changed fields',
      render: (entry) =>
        Object.keys(entry.changedFields).length === 0 ? (
          '—'
        ) : (
          <ul style={{ margin: 0, paddingLeft: 'var(--bx-space-md)' }}>
            {Object.entries(entry.changedFields).map(([field, diff]) => {
              const { old: oldValue, new: newValue } = diff as { old: unknown; new: unknown };
              return (
                <li key={field}>
                  {field}: {JSON.stringify(oldValue)} → {JSON.stringify(newValue)}
                </li>
              );
            })}
          </ul>
        ),
    },
  ];

  return (
    <main id="main-content">
      <PageHeader title="Audit log" />
      <Card style={{ maxWidth: 480 }}>
        <form
          aria-label="Look up audit history"
          onSubmit={handleSubmit}
          style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
        >
          <TextInput
            label="Entity type"
            value={entityType}
            required
            onChange={(e) => setEntityType(e.target.value)}
          />
          <TextInput
            label="Entity ID"
            value={entityId}
            required
            onChange={(e) => setEntityId(e.target.value)}
          />
          {validationDetail ? (
            <p role="alert" aria-live="assertive">
              {validationDetail}
            </p>
          ) : null}
          <Button type="submit" style={{ width: 'fit-content' }}>
            Look up
          </Button>
        </form>
      </Card>

      {submitted ? (
        error && !validationDetail ? (
          <ApiForbiddenGate error={error}>
            <p>Unexpected error</p>
          </ApiForbiddenGate>
        ) : entries.length === 0 && !validationDetail && !auditQuery.isLoading ? (
          <p>No change history for this record.</p>
        ) : entries.length > 0 || auditQuery.isLoading ? (
          <>
            <DataTable
              caption="Audit history"
              rowKey={(e) => `${e.ts}-${e.actorId}`}
              columns={columns}
              rows={entries}
              loading={auditQuery.isLoading && entries.length === 0}
              emptyMessage="No change history for this record."
            />
            {nextCursor ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => void auditQuery.fetchNextPage()}
                loading={auditQuery.isFetchingNextPage}
                style={{ marginTop: 'var(--bx-space-md)' }}
              >
                Load more
              </Button>
            ) : null}
          </>
        ) : null
      ) : null}
    </main>
  );
}
