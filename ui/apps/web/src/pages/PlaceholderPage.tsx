import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import { ClipboardList } from '../components/ui/icons';

/** Placeholder until sibling domain issues ship page bodies. */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <main id="main-content">
      <PageHeader title={title} />
      <EmptyState
        icon={ClipboardList}
        title="This screen isn't built yet"
        description="A sibling ticket ships this page's content on top of the command-console components."
      />
    </main>
  );
}
