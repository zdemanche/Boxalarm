import type { HTMLAttributes, ReactNode } from 'react';
import styles from './Card.module.css';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  raised?: boolean;
}

export function Card({ title, raised = false, className, children, ...rest }: CardProps) {
  return (
    <div
      className={[styles.card, raised ? styles.cardRaised : '', className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {/* h2, not h3: every page that uses Card has exactly one <h1> (PageHeader or the page's
          own heading) directly above it, with nothing at h2 in between — axe's heading-order
          rule (run for real for the first time via tests/e2e/primary-nav.spec.ts's
          mobile-chromium project, MAJOR-1) flagged the previous h3 as an invalid h1-to-h3 skip. */}
      {title ? <h2 className={styles.cardTitle}>{title}</h2> : null}
      {children}
    </div>
  );
}

interface StatProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  alarm?: boolean;
}

/** KPI tile — dashboard command-console numbers (unit counts, expiring certs, OOS apparatus). */
export function Stat({ label, value, hint, alarm = false }: StatProps) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={[styles.statValue, alarm ? styles.statValueAlarm : ''].join(' ')}>
        {value}
      </span>
      {hint ? <span className={styles.statHint}>{hint}</span> : null}
    </div>
  );
}
