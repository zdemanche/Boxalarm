import { Button } from './ui/Button';
import { AlertTriangle } from './ui/icons';
import styles from './StateScreen.module.css';

/**
 * Generic, retryable error state for a non-403 API failure (a transient backend 500, an
 * offline fetch rejection, etc.) — distinct from ForbiddenState (403) and from
 * ConfigErrorBoundary's unrecoverable "Boxalarm can't start" message, which is reserved for a
 * genuinely missing/invalid sign-in configuration.
 */
export function ApiErrorState({
  embedded = false,
  headingLevel = 'h1',
  onRetry,
}: {
  /** When true, render as an alert region (safe inside an existing <main>). */
  embedded?: boolean;
  /** Heading level for the title. Pass 'h2' when embedding inside a page that already
   * renders its own <h1>, so the document never ends up with two level-1 headings. */
  headingLevel?: 'h1' | 'h2';
  /** Defaults to reloading the page when no page-specific retry (e.g. a query refetch) is
   * available. */
  onRetry?: () => void;
}) {
  const Heading = headingLevel;
  const body = (
    <div className={styles.wrapper}>
      <AlertTriangle size={28} className={styles.icon} aria-hidden="true" />
      <Heading className={styles.title}>Something went wrong loading this page</Heading>
      <div role="alert">
        <p className={styles.message}>
          Try again, or contact your department administrator if the problem continues.
        </p>
      </div>
      <Button onClick={onRetry ?? (() => window.location.reload())}>Try again</Button>
    </div>
  );

  if (embedded) return body;
  return <main id="main-content">{body}</main>;
}
