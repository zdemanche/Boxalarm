import styles from './Alerts.module.css';

export function StaleNotice({
  query,
}: {
  query: { error: unknown; data: unknown; dataUpdatedAt: number };
}) {
  if (!query.error || query.data === undefined) return null;
  const receivedAt = query.dataUpdatedAt
    ? ` at ${new Date(query.dataUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : '';
  return (
    <p role="status" className={styles.subtle}>
      Couldn&rsquo;t refresh - showing the last status received{receivedAt}.
    </p>
  );
}
