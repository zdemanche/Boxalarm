import { useState, type FormEvent, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { ApiErrorState } from '../../components/ApiErrorState';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  Button,
  Card,
  DataTable,
  PageHeader,
  Select,
  StatusChip,
  TextInput,
  type DataTableColumn,
} from '../../components/ui';
import { formatDateTime } from '../../lib/dates';
import { humanize } from '../../lib/labels';
import { listMembers } from '../personnel/api';
import { getAuditTrail } from './api';
import type { AuditEntry, AuditFieldChange } from './types';
import styles from './AuditLogPage.module.css';

/**
 * The record types the backend files under a per-record key that platform/audit can read.
 * Left out on purpose, because a lookup for them always comes back empty: DEFECT, CHECK_PHOTO,
 * CHECKLIST_RUN and COMPARTMENT_ITEM are written without that key, and INCIDENT is written to
 * the incident table, which platform/audit does not read.
 */
const AUDIT_ENTITY_TYPES: readonly { value: string; label: string; help: string }[] = [
  {
    value: 'MEMBER',
    label: 'Member',
    help: 'The ID at the end of the member’s page address, e.g. m-24',
  },
  {
    value: 'EQUIPMENT_ASSET',
    label: 'Equipment asset',
    help: 'The ID at the end of the asset’s page address, e.g. eq-3',
  },
  {
    value: 'DEPARTMENT_CONFIG',
    label: 'Department setting',
    help: 'The setting’s name, e.g. LOSAP_POINT_RULES. Only LOSAP point rule changes are recorded today.',
  },
  {
    value: 'OCCUPANCY',
    label: 'Occupancy',
    help: 'The ID at the end of the occupancy’s page address, e.g. occ-6',
  },
  {
    value: 'HYDRANT',
    label: 'Hydrant',
    help: 'The hydrant number, e.g. HYD-025. Archiving is the hydrant change recorded today.',
  },
  {
    value: 'CERTIFICATION',
    label: 'Certification',
    help: 'The certification’s ID, e.g. CERT-m-24-firefighter-i',
  },
  {
    value: 'PPE_ASSIGNMENT',
    label: 'PPE issue',
    help: 'The item type as issued, e.g. helmet or turnout-coat',
  },
  {
    value: 'CONSUMABLE_STOCK',
    label: 'Supply stock',
    help: 'The supply item’s ID, e.g. nitrile-gloves',
  },
  {
    value: 'AVAILABILITY_MARKOFF',
    label: 'Mark-off',
    help: 'The member’s ID and the mark-off’s start time, e.g. m-24-1767268800',
  },
  {
    value: 'EXPORT_JOB',
    label: 'Data export',
    help: 'The export’s job ID, e.g. 8d3f2c1a-5b7e-4c9d-a2f1-6e0b9c4d7a13',
  },
  {
    value: 'RETENTION_DISPOSAL',
    label: 'Records disposal',
    help: 'The disposal run’s trace ID, e.g. 4bf92f3577b34da6a3ce929d0e0e4736',
  },
];

const DEFAULT_ID_HELP = 'The record’s ID, e.g. m-24 for a member';

function entityTypeLabel(value: string): string {
  return AUDIT_ENTITY_TYPES.find((t) => t.value === value)?.label ?? humanize(value);
}

/** Writers disagree on the unit: training, PPE and export store epoch seconds, the rest ms.
 * Any real millisecond timestamp is past 1e12 (2001), any seconds one far below it. */
function toEpochMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

const ACTION_WORD: Readonly<Record<string, string>> = {
  CREATE: 'Created',
  UPDATE: 'Updated',
  DELETE: 'Deleted',
  ARCHIVE: 'Archived',
};

/**
 * The action as a word, and whether it is one of the privileged actions O-17 marks: an export,
 * or a destructive change (a delete - records disposal is one - an archive, which has no undo,
 * or a certification revoked). The backend files an export as CREATE of an EXPORT_JOB and a
 * revoke as an UPDATE to REVOKED, so both are read from the entry, not the action alone.
 */
function describeAction(entry: AuditEntry): { word: string; privileged: boolean } {
  if (entry.mutatedEntityType === 'EXPORT_JOB') return { word: 'Exported', privileged: true };
  if (entry.action === 'UPDATE' && entry.changedFields.status?.new === 'REVOKED') {
    return { word: 'Revoked', privileged: true };
  }
  const privileged = entry.action === 'DELETE' || entry.action === 'ARCHIVE';
  return { word: ACTION_WORD[entry.action] ?? humanize(entry.action), privileged };
}

/** A value as it reads in a sentence: strings bare, lists and maps compact, times as times.
 * Null for "nothing there", which the cell shows as a dash. */
function formatFieldValue(field: string, value: unknown, nested = false): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    // archivedAt, endAt, lockedAt...: epoch times, unreadable as raw numbers.
    return /At$/.test(field) && value > 1e9 ? formatDateTime(toEpochMs(value)) : String(value);
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const items = value.map((item) => formatFieldValue(field, item, true) ?? '—').join(', ');
    return nested ? `[${items}]` : items;
  }
  if (typeof value === 'object') {
    const pairs = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${key}: ${formatFieldValue(key, item, true) ?? '—'}`,
    );
    if (pairs.length === 0) return null;
    return nested ? `{${pairs.join(', ')}}` : pairs.join(', ');
  }
  return String(value);
}

/** A dash that a screen reader reads as "none" rather than skipping or spelling out. */
function FieldValue({ field, value }: { field: string; value: unknown }) {
  const text = formatFieldValue(field, value);
  if (text !== null) return <span className={styles.value}>{text}</span>;
  return (
    <span className={styles.none}>
      <span aria-hidden="true">—</span>
      <span className="visually-hidden">none</span>
    </span>
  );
}

function ChangedFields({ fields }: { fields: Record<string, AuditFieldChange> }) {
  const entries = Object.entries(fields);
  if (entries.length === 0) {
    return (
      <span className={styles.none}>
        <span aria-hidden="true">—</span>
        <span className="visually-hidden">No field changes recorded</span>
      </span>
    );
  }
  return (
    <ul className={styles.diffList}>
      {entries.map(([field, raw]) => {
        // A malformed diff is shown as its new value rather than dropped.
        const change: AuditFieldChange =
          raw !== null && typeof raw === 'object' && ('old' in raw || 'new' in raw)
            ? raw
            : { new: raw };
        return (
          <li key={field} className={styles.diffRow}>
            <span className={styles.field}>{field}</span>{' '}
            <FieldValue field={field} value={change.old} />{' '}
            <span aria-hidden="true" className={styles.arrow}>
              →
            </span>{' '}
            <span className="visually-hidden">to</span>{' '}
            <FieldValue field={field} value={change.new} />
          </li>
        );
      })}
    </ul>
  );
}

interface Lookup {
  entityType: string;
  entityId: string;
}

export function AuditLogPage() {
  const auth = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlType = searchParams.get('entityType')?.trim() ?? '';
  const urlId = searchParams.get('entityId')?.trim() ?? '';
  // The URL is the lookup, so a shared link, Back and Forward all show the same record.
  const lookup: Lookup | null = urlType && urlId ? { entityType: urlType, entityId: urlId } : null;

  const [entityType, setEntityType] = useState(urlType);
  const [entityId, setEntityId] = useState(urlId);
  // Back/Forward change the URL under the form: refill it to match what is shown.
  const [shownUrl, setShownUrl] = useState({ type: urlType, id: urlId });
  if (shownUrl.type !== urlType || shownUrl.id !== urlId) {
    setShownUrl({ type: urlType, id: urlId });
    setEntityType(urlType);
    setEntityId(urlId);
  }

  /** Bumped on every submit, including a resubmit of the same lookup, so the query key always
   * changes and a fresh fetch always fires - an unchanged key gives useInfiniteQuery no reason
   * to refetch, and an unchanged URL no re-render. */
  const [nonce, setNonce] = useState(0);

  const auditQuery = useInfiniteQuery({
    queryKey: ['platform', 'audit', lookup?.entityType, lookup?.entityId, nonce],
    queryFn: ({ pageParam }) =>
      getAuditTrail(auth, lookup!.entityType, lookup!.entityId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: lookup !== null,
  });

  // Actor IDs are member IDs (the sign-in sub); the roster the app already reads names them.
  const membersQuery = useQuery({
    queryKey: ['personnel', 'members'],
    queryFn: () => listMembers(auth),
    enabled: lookup !== null,
  });
  const memberNames = new Map(
    (membersQuery.data ?? []).map((m) => [m.memberId, `${m.firstName} ${m.lastName}`]),
  );

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const next = { entityType, entityId: entityId.trim() };
    const unchanged = next.entityType === urlType && next.entityId === urlId;
    // A resubmit refreshes in place; it is not a new place to go Back to.
    setSearchParams(next, { replace: unchanged });
    setNonce((n) => n + 1);
  }

  const entries = auditQuery.data?.pages.flatMap((page) => page.entries) ?? [];
  const nextCursor = auditQuery.data?.pages.at(-1)?.nextCursor;

  // A failed "Load more" keeps what already loaded on screen; only a failed lookup replaces it.
  const loadMoreFailed = auditQuery.isFetchNextPageError;
  const error = loadMoreFailed ? null : auditQuery.error;
  const validationDetail =
    error instanceof ApiError && error.problem.status === 400 ? error.problem.detail : null;
  const forbidden = error instanceof ApiError && error.problem.status === 403;

  const typeKnown = AUDIT_ENTITY_TYPES.some((t) => t.value === entityType);
  const idHelp = AUDIT_ENTITY_TYPES.find((t) => t.value === entityType)?.help ?? DEFAULT_ID_HELP;

  // Timestamps and IDs are compared character by character, so they read in mono (design §2.4).
  const columns: DataTableColumn<AuditEntry>[] = [
    {
      key: 'ts',
      header: 'Timestamp',
      render: (e) => <span className={styles.mono}>{formatDateTime(toEpochMs(e.ts))}</span>,
    },
    {
      key: 'actorId',
      header: 'Actor',
      render: (e) => {
        const name = e.actorId.startsWith('system:') ? 'System' : memberNames.get(e.actorId);
        return (
          <span className={styles.actor}>
            {name ? <span className={styles.actorName}>{name}</span> : null}
            <span className={styles.mono}>{e.actorId}</span>
          </span>
        );
      },
    },
    {
      key: 'action',
      header: 'Action',
      render: (e) => {
        const { word, privileged } = describeAction(e);
        return privileged ? (
          <StatusChip status="danger">
            {word}
            <span className="visually-hidden"> (privileged action)</span>
          </StatusChip>
        ) : (
          word
        );
      },
    },
    {
      key: 'changedFields',
      header: 'Changed fields',
      render: (e) => <ChangedFields fields={e.changedFields} />,
    },
  ];

  let history: ReactNode;
  if (!lookup) {
    history = (
      <p className={styles.lead}>
        Choose a record type and enter its ID to see every recorded change to it. Record pages link
        here from their Change history button.
      </p>
    );
  } else if (validationDetail) {
    history = <p className={styles.lead}>Fix the lookup to see this record&apos;s history.</p>;
  } else if (forbidden) {
    history = (
      <ApiForbiddenGate error={error} embedded>
        {null}
      </ApiForbiddenGate>
    );
  } else if (error) {
    history = (
      <ApiErrorState embedded headingLevel="h2" onRetry={() => void auditQuery.refetch()} />
    );
  } else if (!auditQuery.isLoading && entries.length === 0) {
    history = (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>No change history for this record.</p>
        <p className={styles.lead}>
          Check the type and ID: IDs must match exactly, including capital letters.
        </p>
      </div>
    );
  } else {
    history = (
      <>
        {membersQuery.isError ? (
          <p role="status" className={styles.partial}>
            Member names couldn&apos;t be resolved. IDs are shown instead.
          </p>
        ) : null}
        <DataTable
          caption={`Change history for ${entityTypeLabel(lookup.entityType)} ${lookup.entityId}`}
          rowKey={(e) => `${e.ts}-${e.actorId}`}
          columns={columns}
          rows={entries}
          loading={auditQuery.isLoading}
          emptyMessage="No change history for this record."
        />
        {loadMoreFailed ? (
          <p role="alert" className={styles.validation}>
            Couldn&apos;t load older changes. Try again.
          </p>
        ) : null}
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
    );
  }

  return (
    <main id="main-content">
      <PageHeader
        title="Audit log"
        description="Who changed a department record, what they changed, and when."
      />
      <div className={styles.stack}>
        <Card title="Look up a record">
          <form aria-label="Look up audit history" onSubmit={handleSubmit} className={styles.form}>
            <div className={styles.fields}>
              <Select
                label="Record type"
                value={entityType}
                required
                onChange={(e) => setEntityType(e.target.value)}
              >
                <option value="">Choose a record type</option>
                {AUDIT_ENTITY_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
                {/* A link from elsewhere may name a type this list doesn't offer. */}
                {entityType && !typeKnown ? (
                  <option value={entityType}>{humanize(entityType)}</option>
                ) : null}
              </Select>
              <TextInput
                label="Record ID"
                help={idHelp}
                value={entityId}
                required
                autoComplete="off"
                spellCheck={false}
                className={styles.monoInput}
                onChange={(e) => setEntityId(e.target.value)}
              />
            </div>
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
          {lookup ? (
            <p className={styles.subject}>
              {entityTypeLabel(lookup.entityType)}{' '}
              <span className={styles.mono}>{lookup.entityId}</span>
              {lookup.entityType === 'MEMBER' && memberNames.get(lookup.entityId)
                ? ` · ${memberNames.get(lookup.entityId)}`
                : null}
            </p>
          ) : null}
          {history}
        </Card>
      </div>
    </main>
  );
}
