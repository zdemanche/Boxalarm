import type { HTMLAttributes, ReactNode } from 'react';
import type { StatusRole } from '@boxalarm/design-tokens';
import { STATUS_ICON } from './icons';
import styles from './Chip.module.css';

interface StatusChipProps extends HTMLAttributes<HTMLSpanElement> {
  status: StatusRole;
  /** The word — always shown; colour and glyph are never the sole carrier (N7.1). */
  children: ReactNode;
}

/** Colour + glyph + word, per design.draft.md §2.3 / a11y-spec.draft.md §1.8. Never render a
 * status with colour alone — every call site supplies the word as `children`. */
export function StatusChip({ status, children, className, style, ...rest }: StatusChipProps) {
  const Icon = STATUS_ICON[status];
  return (
    <span
      className={[styles.chip, className].filter(Boolean).join(' ')}
      style={{
        color: `var(--bx-status-${status})`,
        background: `color-mix(in srgb, var(--bx-status-${status}) 14%, transparent)`,
        ...style,
      }}
      data-status={status}
      {...rest}
    >
      <Icon size={13} aria-hidden="true" />
      {children}
    </span>
  );
}

export function Badge({ children, className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={[styles.badge, className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </span>
  );
}
