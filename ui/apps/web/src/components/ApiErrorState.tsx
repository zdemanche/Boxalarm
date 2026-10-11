import { Link, useInRouterContext, useLocation } from 'react-router-dom';
import { Button, buttonClassName } from './ui/Button';
import { AlertTriangle } from './ui/icons';
import styles from './StateScreen.module.css';

const TITLE = 'Something went wrong loading this page';
const MESSAGE = 'Try again, or contact your department administrator if the problem continues.';

/** The way out when retrying doesn't help - except on the dashboard itself. */
function BackToDashboard() {
  const { pathname } = useLocation();
  if (pathname === '/') return null;
  return (
    <Link to="/" className={buttonClassName({ variant: 'secondary' })}>
      Back to dashboard
    </Link>
  );
}

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
  const inRouter = useInRouterContext();
  const retry = onRetry ?? (() => window.location.reload());
  const message = (
    <div role="alert">
      <p className={styles.message}>{MESSAGE}</p>
    </div>
  );

  if (embedded) {
    return (
      <div className={styles.inline}>
        <span className={[styles.badge, styles.badgeDanger].join(' ')}>
          <AlertTriangle size={18} aria-hidden="true" />
        </span>
        <div className={styles.inlineBody}>
          <Heading className={styles.title}>{TITLE}</Heading>
          {message}
          <div className={styles.actions}>
            <Button variant="secondary" onClick={retry}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <main id="main-content" className={styles.page}>
      <div className={styles.card}>
        <span className={[styles.badge, styles.badgeDanger].join(' ')}>
          <AlertTriangle size={24} aria-hidden="true" />
        </span>
        <Heading className={styles.title}>{TITLE}</Heading>
        {message}
        <div className={styles.actions}>
          <Button onClick={retry}>Try again</Button>
          {/* The router is always there in the app; a bare unit-test mount has no Link target. */}
          {inRouter ? <BackToDashboard /> : null}
        </div>
      </div>
    </main>
  );
}
