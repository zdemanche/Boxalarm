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
    <>
      <Heading style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>
        Something went wrong loading this page
      </Heading>
      <div role="alert">
        <p style={{ marginTop: 'var(--boxalarm-spacing-md)' }}>
          Try again, or contact your department administrator if the problem continues.
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry ?? (() => window.location.reload())}
        style={{ marginTop: 'var(--boxalarm-spacing-md)', minHeight: 44 }}
      >
        Try again
      </button>
    </>
  );

  if (embedded) {
    return <section style={{ padding: 'var(--boxalarm-spacing-lg)' }}>{body}</section>;
  }

  return (
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      {body}
    </main>
  );
}
