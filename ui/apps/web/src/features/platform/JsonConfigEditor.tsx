import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { getConfig, putConfig } from './api';
import type { ConfigResponse, EditableConfigType } from './types';

export function JsonConfigEditor({
  configType,
  label,
  helpText,
}: {
  configType: EditableConfigType;
  label: string;
  helpText: string;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ['platform', 'config', configType];

  const configQuery = useQuery({
    queryKey,
    queryFn: async (): Promise<ConfigResponse | null> => {
      try {
        return await getConfig(auth, configType);
      } catch (error) {
        if (error instanceof ApiError && error.problem.status === 404) return null;
        throw error;
      }
    },
  });

  const [draft, setDraft] = useState('{}');
  const [formError, setFormError] = useState<string | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [forbiddenError, setForbiddenError] = useState<unknown>(null);

  useEffect(() => {
    if (configQuery.data !== undefined) {
      setDraft(JSON.stringify(configQuery.data?.value ?? {}, null, 2));
    }
  }, [configQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (value: Record<string, unknown>) =>
      putConfig(auth, configType, value, configQuery.data?.version),
    onSuccess: (saved) => {
      setConflictMessage(null);
      setFormError(null);
      setForbiddenError(null);
      queryClient.setQueryData(queryKey, saved);
    },
    onError: async (error: unknown) => {
      if (error instanceof ApiError && error.problem.status === 409) {
        setForbiddenError(null);
        setConflictMessage(
          'This config was updated by someone else. Showing the latest value — review and save again.',
        );
        await queryClient.invalidateQueries({ queryKey });
        return;
      }
      if (error instanceof ApiError && error.problem.status === 403) {
        setFormError(null);
        setForbiddenError(error);
        return;
      }
      if (error instanceof ApiError) {
        setForbiddenError(null);
        setFormError(error.problem.detail ?? error.problem.title);
        return;
      }
      setForbiddenError(null);
      setFormError('Could not save. Try again.');
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setForbiddenError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      setFormError('Must be valid JSON.');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setFormError('Must be a JSON object.');
      return;
    }
    saveMutation.mutate(parsed as Record<string, unknown>);
  }

  const inputId = `config-input-${configType}`;

  return (
    <section
      aria-labelledby={`config-heading-${configType}`}
      style={{ marginTop: 'var(--boxalarm-spacing-xl)' }}
    >
      <h2 id={`config-heading-${configType}`} style={{ fontSize: 'var(--boxalarm-font-size-lg)' }}>
        {label}
      </h2>
      <p style={{ fontSize: 'var(--boxalarm-font-size-sm)', opacity: 0.8 }}>{helpText}</p>
      {configQuery.isLoading ? (
        <p>Loading {label}…</p>
      ) : configQuery.error ? (
        <ApiForbiddenGate error={configQuery.error} embedded>
          <p role="alert">Unable to load {label}.</p>
        </ApiForbiddenGate>
      ) : (
        <form
          onSubmit={handleSubmit}
          style={{
            display: 'grid',
            gap: 'var(--boxalarm-spacing-sm)',
            maxWidth: 640,
          }}
        >
          <label htmlFor={inputId} style={{ display: 'grid', gap: 4 }}>
            {label} (JSON)
            <textarea
              id={inputId}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={8}
              style={{
                fontFamily: 'monospace',
                fontSize: 'var(--boxalarm-font-size-sm)',
                padding: 'var(--boxalarm-spacing-sm)',
                borderRadius: 'var(--boxalarm-radius-default)',
              }}
            />
          </label>
          {forbiddenError ? (
            <ApiForbiddenGate error={forbiddenError} embedded>
              <p role="alert">Could not save {label}.</p>
            </ApiForbiddenGate>
          ) : null}
          {formError ? (
            <p role="alert" aria-live="assertive">
              {formError}
            </p>
          ) : null}
          {conflictMessage ? (
            <p role="alert" aria-live="assertive">
              {conflictMessage}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={saveMutation.isPending}
            style={{ minHeight: 44, width: 'fit-content' }}
          >
            Save {label}
          </button>
        </form>
      )}
    </section>
  );
}
