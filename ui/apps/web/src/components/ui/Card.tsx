import type { HTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { LucideIcon } from './icons';
import styles from './Card.module.css';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  raised?: boolean;
  /** Right-aligned beside the title: a "View all" link or the card's one action. */
  actions?: ReactNode;
}

export function Card({ title, raised = false, actions, className, children, ...rest }: CardProps) {
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
      {title && actions ? (
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{title}</h2>
          <div className={styles.cardActions}>{actions}</div>
        </div>
      ) : title ? (
        <h2 className={styles.cardTitle}>{title}</h2>
      ) : null}
      {children}
    </div>
  );
}

interface StatProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  alarm?: boolean;
  /** The tile's source list (design.md O-02: "every KPI tile links to its source list"). */
  to?: string;
  /** Decorative glyph in the tile's corner; alarm-tinted when the value is an alarm. */
  icon?: LucideIcon;
}

/** KPI tile — dashboard command-console numbers (unit counts, expiring certs, OOS apparatus). */
export function Stat({ label, value, hint, alarm = false, to, icon: Icon }: StatProps) {
  const content = (
    <>
      <span className={styles.statHead}>
        <span className={styles.statLabel}>{label}</span>
        {Icon ? (
          <span className={[styles.statIcon, alarm ? styles.statIconAlarm : ''].join(' ')}>
            <Icon size={18} aria-hidden="true" />
          </span>
        ) : null}
      </span>
      <span className={[styles.statValue, alarm ? styles.statValueAlarm : ''].join(' ')}>
        {value}
      </span>
      {hint ? <span className={styles.statHint}>{hint}</span> : null}
    </>
  );
  if (to) {
    return (
      <Link to={to} className={[styles.stat, styles.statLink].join(' ')}>
        {content}
      </Link>
    );
  }
  return <div className={styles.stat}>{content}</div>;
}
