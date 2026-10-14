import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Badge, Button, Card, Skeleton, TextInput } from '../../components/ui';
import { RetryableApiGate } from './RetryableApiGate';
import { getRetentionConfig, putRetentionConfig } from './api';
import { LIFE_SAFETY_RECORD_CLASSES } from './types';
import styles from './Settings.module.css';

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

  return (
    <Card title="Records retention">
      <p className={styles.lead}>
        How long department records are kept before disposal removes them.
      </p>
      {retentionQuery.isLoading ? (
        <Skeleton lines={2} />
      ) : retentionQuery.error ? (
        <RetryableApiGate
          error={retentionQuery.error}
          onRetry={() => void retentionQuery.refetch()}
        >
          <p role="alert">Unable to load the retention configuration.</p>
        </RetryableApiGate>
      ) : (
        <form onSubmit={handleSubmit} className={styles.form}>
          <TextInput
            label="Retention period (years)"
            type="number"
            min={1}
            step={1}
            value={years}
            onChange={(e) => setYears(e.target.value)}
            error={formError ?? undefined}
          />
          {formForbidden ? (
            <ApiForbiddenGate error={formForbidden} embedded>
              <p role="alert">Could not save the retention period.</p>
            </ApiForbiddenGate>
          ) : null}
          <div className={styles.formFooter}>
            <Button type="submit" variant="secondary" loading={saveMutation.isPending}>
              Save retention period
            </Button>
          </div>
        </form>
      )}

      <div className={styles.subsection}>
        <h3 className={styles.subheading}>Not subject to automatic disposal</h3>
        <ul className={styles.badges}>
          {LIFE_SAFETY_RECORD_CLASSES.map((recordClass) => (
            <li key={recordClass}>
              <Badge>{recordClass}</Badge>
            </li>
          ))}
        </ul>
      </div>

      <div className={styles.subsection}>
        <h3 className={styles.subheading}>Disposal of expired records</h3>
        <p className={styles.rowMeta}>
          Records past the retention period are not listed here yet, so disposal cannot be started
          from this page. The daily retention sweep notifies the chief when records have passed it.
        </p>
      </div>
    </Card>
  );
}
