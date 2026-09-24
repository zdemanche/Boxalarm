import type { ReactNode } from 'react';
import type { LucideIcon } from './icons';
import styles from './EmptyState.module.css';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}

/** One sentence of why it's empty, plus one primary action — never a bare "No results". */
export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className={styles.wrapper}>
      {Icon ? <Icon size={28} className={styles.icon} aria-hidden="true" /> : null}
      <p className={styles.title}>{title}</p>
      {description ? <p className={styles.description}>{description}</p> : null}
      {action}
    </div>
  );
}
