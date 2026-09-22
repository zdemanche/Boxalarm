import { ApiError } from '../lib/apiClient';
import { ApiErrorState } from './ApiErrorState';
import { ForbiddenState } from './ForbiddenState';

/**
 * Render ForbiddenState for an API 403 problem+json, a generic retryable ApiErrorState for any
 * other error, or children when there is no error.
 *
 * Non-403 errors used to be rethrown here, which bubbled up to ConfigErrorBoundary — the only
 * error boundary in the tree — and produced its unrecoverable "Boxalarm can't start / sign-in
 * configuration is missing or invalid" message for a transient backend 500 or an offline fetch
 * rejection just as much as for a real config problem. Rendering inline here (scoped to the
 * page that hit the error) keeps that distinction; RouteErrorBoundary (apps/web/src/App.tsx via
 * AppShell) is the backstop for errors that don't go through this gate at all.
 */
export function ApiForbiddenGate({
  error,
  children,
  embedded = false,
}: {
  error: unknown;
  children: React.ReactNode;
  /** Pass true when already inside a page <main> to avoid nested landmarks. */
  embedded?: boolean;
}) {
  if (error instanceof ApiError && error.problem.status === 403) {
    return (
      <ForbiddenState
        problem={error.problem}
        embedded={embedded}
        headingLevel={embedded ? 'h2' : 'h1'}
      />
    );
  }
  if (error) {
    return <ApiErrorState embedded={embedded} headingLevel={embedded ? 'h2' : 'h1'} />;
  }
  return children;
}
