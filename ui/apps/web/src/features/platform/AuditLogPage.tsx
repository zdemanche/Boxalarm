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
import { formatDateTime } from '../../lib/dates';
import { getAuditTrail } from './api';
import type { AuditEntry } from './types';
import styles from './AuditLogPage.module.css';

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

  // Timestamps and IDs are compared character by character, so they read in mono (design §2.4).
  const columns: DataTableColumn<AuditEntry>[] = [
    {
      key: 'ts',
      header: 'Timestamp',
      render: (e) => <span className={styles.mono}>{formatDateTime(e.ts)}</span>,
    },
    {
      key: 'actorId',
      header: 'Actor',
      render: (e) => <span className={styles.mono}>{e.actorId}</span>,
    },
    { key: 'action', header: 'Action', render: (e) => e.action },
    {
      key: 'changedFields',
      header: 'Changed fields',
      render: (entry) =>
        Object.keys(entry.changedFields).length === 0 ? (
          '—'
        ) : (
          <ul className={styles.diffList}>
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

  const lookedUp = submitted ? `${submitted.entityType} ${submitted.entityId}` : null;

  return (
    <main id="main-content">
      <PageHeader
        title="Audit log"
        description="Who changed a department record, what they changed, and when."
      />
      <div className={styles.layout}>
        <Card title="Look up a record">
          <form aria-label="Look up audit history" onSubmit={handleSubmit} className={styles.form}>
            <TextInput
              label="Entity type"
              help="e.g. MEMBER, APPARATUS, HYDRANT or DEPARTMENT_CONFIG"
              value={entityType}
              required
              onChange={(e) => setEntityType(e.target.value)}
            />
            <TextInput
              label="Entity ID"
              help="The record's ID, e.g. HYD-022 or ALERT_RULES"
              value={entityId}
              required
              onChange={(e) => setEntityId(e.target.value)}
            />
            {validationDetail ? (
              <p role="alert" aria-live="assertive" className={styles.validation}>
                {validationDetail}
              </p>
            ) : null}
            <div className={styles.formFooter}>
              <Button type="submit">Look up</Button>
            </div>
          </form>
        </Card>

        <Card title="History">
          {!submitted ? (
            <p className={styles.lead}>
              Enter a record&apos;s type and ID to see every recorded change to it.
            </p>
          ) : error && !validationDetail ? (
            <ApiForbiddenGate error={error} embedded>
              <p>Unexpected error</p>
            </ApiForbiddenGate>
          ) : entries.length === 0 && !validationDetail && !auditQuery.isLoading ? (
            <p className={styles.lead}>No change history for this record.</p>
          ) : entries.length > 0 || auditQuery.isLoading ? (
            <>
              <DataTable
                caption={lookedUp ? `Audit history for ${lookedUp}` : 'Audit history'}
                rowKey={(e) => `${e.ts}-${e.actorId}`}
                columns={columns}
                rows={entries}
                loading={auditQuery.isLoading && entries.length === 0}
                emptyMessage="No change history for this record."
              />
              {nextCursor ? (
                <div className={styles.more}>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void auditQuery.fetchNextPage()}
                    loading={auditQuery.isFetchingNextPage}
                  >
                    Load more
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <p className={styles.lead}>Fix the lookup to see this record&apos;s history.</p>
          )}
        </Card>
      </div>
    </main>
  );
}
