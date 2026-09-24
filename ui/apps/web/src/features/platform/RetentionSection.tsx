import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { getRetentionConfig, putRetentionConfig, runDisposal } from './api';
import { LIFE_SAFETY_RECORD_CLASSES, type DisposalResult } from './types';

const RETENTION_QUERY_KEY = ['platform', 'retention'];

export function RetentionSection() {
  const auth = useAuth();
  const queryClient = useQueryClient();

  const retentionQuery = useQuery({
    queryKey: RETENTION_QUERY_KEY,
    queryFn: () => getRetentionConfig(auth),
  });

  const [years, setYears] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [formForbidden, setFormForbidden] = useState<unknown>(null);
  const [disposalResult, setDisposalResult] = useState<DisposalResult | null>(null);
  const [disposalError, setDisposalError] = useState<string | null>(null);
  const [disposalForbidden, setDisposalForbidden] = useState<unknown>(null);

  useEffect(() => {
    if (retentionQuery.data) {
      setYears(String(retentionQuery.data.retentionYears));
    }
  }, [retentionQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (retentionYears: number) => putRetentionConfig(auth, retentionYears),
    onSuccess: async () => {
      setFormError(null);
      setFormForbidden(null);
      await queryClient.invalidateQueries({ queryKey: RETENTION_QUERY_KEY });
    },
    onError: async (error: unknown) => {
      if (error instanceof ApiError && error.problem.status === 409) {
        setFormForbidden(null);
        setFormError('Retention was updated concurrently. Showing the latest value.');
        await queryClient.invalidateQueries({ queryKey: RETENTION_QUERY_KEY });
        return;
      }
      if (error instanceof ApiError && error.problem.status === 403) {
        setFormError(null);
        setFormForbidden(error);
        return;
      }
      setFormForbidden(null);
      setFormError('Could not save the retention period.');
    },
  });

  const disposalMutation = useMutation({
    mutationFn: () => runDisposal(auth),
    onSuccess: (result) => {
      setDisposalError(null);
      setDisposalForbidden(null);
      setDisposalResult(result);
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.problem.status === 403) {
        setDisposalError(null);
        setDisposalForbidden(error);
        return;
      }
      setDisposalForbidden(null);
      setDisposalError('Disposal could not be run. Try again.');
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormForbidden(null);
    const parsed = Number(years);
    if (!Number.isInteger(parsed) || parsed < 1) {
      setFormError('Retention period must be a positive whole number of years.');
      return;
    }
    saveMutation.mutate(parsed);
  }

  function handleDisposal() {
    if (
      window.confirm(
        'Run records disposal now? Records past their retention period will be permanently destroyed and an audit event written.',
      )
    ) {
      disposalMutation.mutate();
    }
  }

  return (
    <section
      aria-labelledby="retention-heading"
      style={{ marginTop: 'var(--boxalarm-spacing-xl)' }}
    >
      <h2 id="retention-heading" style={{ fontSize: 'var(--boxalarm-font-size-lg)' }}>
        Records retention
      </h2>
      {retentionQuery.isLoading ? (
        <p>Loading retention configuration…</p>
      ) : retentionQuery.error ? (
        <ApiForbiddenGate error={retentionQuery.error} embedded>
          <p role="alert">Unable to load the retention configuration.</p>
        </ApiForbiddenGate>
      ) : (
        <form
          onSubmit={handleSubmit}
          style={{ display: 'grid', gap: 'var(--boxalarm-spacing-sm)', maxWidth: 320 }}
        >
          <label htmlFor="retention-years" style={{ display: 'grid', gap: 4 }}>
            Retention period (years)
            <input
              id="retention-years"
              type="number"
              min={1}
              step={1}
              value={years}
              onChange={(e) => setYears(e.target.value)}
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          {formForbidden ? (
            <ApiForbiddenGate error={formForbidden} embedded>
              <p role="alert">Could not save the retention period.</p>
            </ApiForbiddenGate>
          ) : null}
          {formError ? (
            <p role="alert" aria-live="assertive">
              {formError}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={saveMutation.isPending}
            style={{ minHeight: 44, width: 'fit-content' }}
          >
            Save retention period
          </button>
        </form>
      )}

      <h3
        style={{
          fontSize: 'var(--boxalarm-font-size-base)',
          marginTop: 'var(--boxalarm-spacing-lg)',
        }}
      >
        Not subject to automatic disposal
      </h3>
      <ul>
        {LIFE_SAFETY_RECORD_CLASSES.map((recordClass) => (
          <li key={recordClass}>{recordClass}</li>
        ))}
      </ul>

      <button
        type="button"
        onClick={handleDisposal}
        disabled={
          disposalMutation.isPending || retentionQuery.isLoading || Boolean(retentionQuery.error)
        }
        style={{ minHeight: 44, marginTop: 'var(--boxalarm-spacing-md)' }}
      >
        Run disposal
      </button>
      {retentionQuery.error ? (
        <p role="alert">
          The retention period could not be confirmed, so disposal is disabled until it loads
          successfully.
        </p>
      ) : null}
      {disposalForbidden ? (
        <ApiForbiddenGate error={disposalForbidden} embedded>
          <p role="alert">Disposal could not be run.</p>
        </ApiForbiddenGate>
      ) : null}
      {disposalError ? (
        <p role="alert" aria-live="assertive">
          {disposalError}
        </p>
      ) : null}
      {disposalResult ? (
        <p role="status">
          {disposalResult.hardDeleted} deleted, {disposalResult.cryptoShredded} crypto-shredded,{' '}
          {disposalResult.refused.length} refused.
        </p>
      ) : null}
    </section>
  );
}
