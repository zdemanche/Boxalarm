import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, Skeleton, Textarea } from '../../components/ui';
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

  return (
    <Card title={label} style={{ marginTop: 'var(--bx-space-xl)' }}>
      <p style={{ fontSize: 12, color: 'var(--bx-fg-muted)' }}>{helpText}</p>
      {configQuery.isLoading ? (
        <Skeleton lines={3} />
      ) : configQuery.error ? (
        <ApiForbiddenGate error={configQuery.error} embedded>
          <p role="alert">Unable to load {label}.</p>
        </ApiForbiddenGate>
      ) : (
        <form
          onSubmit={handleSubmit}
          style={{ display: 'grid', gap: 'var(--bx-space-sm)', maxWidth: 640 }}
        >
          <Textarea
            label={`${label} (JSON)`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            style={{ fontFamily: 'var(--bx-font-mono)' }}
          />
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
          <Button type="submit" loading={saveMutation.isPending} style={{ width: 'fit-content' }}>
            Save {label}
          </Button>
        </form>
      )}
    </Card>
  );
}
