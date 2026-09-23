/** Placeholder until sibling domain issues ship page bodies. */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>{title}</h1>
    </main>
  );
}
