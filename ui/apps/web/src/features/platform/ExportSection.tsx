import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { startExport, getExportStatus } from './api';

const EXPORT_POLL_INTERVAL_MS = 3_000;

export function ExportSection() {
  const auth = useAuth();
  const [jobId, setJobId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [startForbidden, setStartForbidden] = useState<unknown>(null);

  const startMutation = useMutation({
    mutationFn: () => startExport(auth),
    onSuccess: (result) => {
      setStartError(null);
      setStartForbidden(null);
      setJobId(result.jobId);
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.problem.status === 403) {
        setStartError(null);
        setStartForbidden(error);
        return;
      }
      setStartForbidden(null);
      setStartError('Could not start the export. Try again.');
    },
  });

  const statusQuery = useQuery({
    queryKey: ['platform', 'export', jobId],
    queryFn: () => getExportStatus(auth, jobId as string),
    enabled: jobId !== null,
    refetchInterval: (query) =>
      query.state.data?.status === 'PENDING' ? EXPORT_POLL_INTERVAL_MS : false,
  });

  function handleExport() {
    if (
      window.confirm(
        'Export all department data? This writes an audit event and is visible to the chief.',
      )
    ) {
      setJobId(null);
      startMutation.mutate();
    }
  }

  const status = statusQuery.data?.status;

  return (
    <section aria-labelledby="export-heading" style={{ marginTop: 'var(--boxalarm-spacing-xl)' }}>
      <h2 id="export-heading" style={{ fontSize: 'var(--boxalarm-font-size-lg)' }}>
        Full department export
      </h2>
      <button
        type="button"
        onClick={handleExport}
        disabled={startMutation.isPending}
        style={{ minHeight: 44 }}
      >
        Export department data
      </button>
      {startForbidden ? (
        <ApiForbiddenGate error={startForbidden} embedded>
          <p role="alert">Could not start the export.</p>
        </ApiForbiddenGate>
      ) : null}
      {startError ? (
        <p role="alert" aria-live="assertive">
          {startError}
        </p>
      ) : null}
      {jobId && statusQuery.error ? (
        <ApiForbiddenGate error={statusQuery.error} embedded>
          <p role="alert">Could not check export status.</p>
        </ApiForbiddenGate>
      ) : jobId && status === 'FAILED' ? (
        <p role="alert">The export failed. Try again.</p>
      ) : jobId && status === 'COMPLETE' && statusQuery.data?.status === 'COMPLETE' ? (
        <ul>
          {statusQuery.data.files.map((file) => (
            <li key={file.table}>
              <a href={file.url}>{file.table}</a>
            </li>
          ))}
        </ul>
      ) : jobId ? (
        <p role="status">Export in progress…</p>
      ) : null}
    </section>
  );
}
