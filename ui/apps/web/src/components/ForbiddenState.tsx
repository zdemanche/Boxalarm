import type { ProblemDetails } from '../lib/apiClient';

export function ForbiddenState({
  problem,
  embedded = false,
}: {
  problem?: Pick<ProblemDetails, 'detail' | 'traceId' | 'title'>;
  /** When true, render as an alert region (safe inside an existing <main>). */
  embedded?: boolean;
}) {
  const body = (
    <>
      <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>
        {problem?.title ?? 'Forbidden'}
      </h1>
      <div role="alert">
        <p style={{ marginTop: 'var(--boxalarm-spacing-md)' }}>
          {problem?.detail ?? 'You do not have access to this page.'}
        </p>
        {problem?.traceId ? (
          <p
            style={{
              marginTop: 'var(--boxalarm-spacing-sm)',
              fontSize: 'var(--boxalarm-font-size-sm)',
            }}
          >
            Reference: <code>{problem.traceId}</code>
          </p>
        ) : null}
      </div>
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
