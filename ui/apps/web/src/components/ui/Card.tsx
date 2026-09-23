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
      {title ? <h3 className={styles.cardTitle}>{title}</h3> : null}
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
