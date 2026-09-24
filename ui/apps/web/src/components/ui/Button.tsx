import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Loader2, type LucideIcon } from './icons';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

const SIZE_CLASS: Record<ButtonSize, string | undefined> = {
  sm: styles.sizeSm,
  md: styles.sizeMd,
  lg: styles.sizeLg,
};

const VARIANT_CLASS: Record<ButtonVariant, string | undefined> = {
  primary: styles.primary,
  secondary: styles.secondary,
  ghost: styles.ghost,
  danger: styles.danger,
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    disabled,
    className,
    children,
    onClick,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={[styles.button, SIZE_CLASS[size], VARIANT_CLASS[variant], className]
        .filter(Boolean)
        .join(' ')}
      // `loading` never sets the native `disabled` attribute — a disabled button drops focus to
      // <body> the instant it's set, stranding keyboard/screen-reader users on submit
      // (docs/a11y-spec.md:367: "never disabled"). It stays focusable and its accessible state is
      // carried by aria-disabled + aria-busy; activation is a no-op below instead.
      disabled={disabled}
      aria-disabled={loading || disabled || undefined}
      aria-busy={loading || undefined}
      onClick={(event) => {
        if (loading) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      {...rest}
    >
      {loading ? <Loader2 className={styles.spinner} size={16} aria-hidden="true" /> : null}
      {children}
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, variant = 'ghost', size = 'md', className, ...rest },
  ref,
) {
  const iconPx = size === 'sm' ? 16 : size === 'lg' ? 24 : 18;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={[styles.button, styles.icon, SIZE_CLASS[size], VARIANT_CLASS[variant], className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      <Icon size={iconPx} aria-hidden="true" />
    </button>
  );
});
