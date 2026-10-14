import { Card, PageHeader } from '../components/ui';
import { ClipboardList } from '../components/ui/icons';
import styles from '../components/StateScreen.module.css';

/** Placeholder until sibling domain issues ship page bodies. */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <main id="main-content">
      <PageHeader title={title} description="This part of Boxalarm is on its way." />
      <Card>
        <div className={[styles.inline, styles.plain].join(' ')}>
          <span className={styles.badge}>
            <ClipboardList size={18} aria-hidden="true" />
          </span>
          <div className={styles.inlineBody}>
            <h2 className={styles.title}>This screen isn&apos;t built yet</h2>
            <p className={styles.detail}>
              A sibling ticket ships this page&apos;s content on top of the command-console
              components.
            </p>
          </div>
        </div>
      </Card>
    </main>
  );
}
