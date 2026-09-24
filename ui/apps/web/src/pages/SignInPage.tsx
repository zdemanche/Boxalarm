import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { radius, spacing, typography } from '@boxalarm/design-tokens';
import { useAuth } from '../auth/AuthContext';
import { buildForgotPasswordUrl } from '../auth/config';
import { Flame } from '../components/ui/icons';
import styles from './SignInPage.module.css';

// These two inline styles are pinned by SignInPage.test.tsx (mobile design-system parity) —
// keep the values, not just the intent, if this file changes again.
const headingStyle: CSSProperties = {
  fontSize: typography.size.display,
  margin: 0,
};

const buttonStyle: CSSProperties = {
  minWidth: 220,
  minHeight: 56,
  fontSize: typography.size.lg,
  fontWeight: 600,
  padding: `${spacing.md}px ${spacing.lg}px`,
  background: 'var(--boxalarm-accent)',
  color: 'var(--boxalarm-bg)',
  borderRadius: radius.default,
  border: 'none',
  cursor: 'pointer',
};

const linkButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: 'transparent',
  color: 'var(--boxalarm-fg)',
  border: '1px solid var(--boxalarm-fg)',
  fontWeight: 500,
  minHeight: 48,
  fontSize: typography.size.base,
};

export function SignInPage() {
  const { signIn } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const handleSignIn = () => {
    setError(null);
    signIn().catch(() => {
      setError('Sign-in could not be started. Check your connection and try again.');
    });
  };

  const handleForgotPassword = () => {
    setError(null);
    try {
      window.location.assign(buildForgotPasswordUrl());
    } catch {
      setError('Password recovery could not be started. Check your connection and try again.');
    }
  };

  return (
    <main className={styles.page}>
      <div className={styles.brand}>
        <Flame size={28} aria-hidden="true" />
        <h1 style={headingStyle}>Boxalarm</h1>
      </div>
      <p className={styles.tagline}>Sign in to your department's command console.</p>
      <div className={styles.actions}>
        <button type="button" onClick={handleSignIn} style={buttonStyle}>
          Sign in
        </button>
        <button type="button" onClick={handleForgotPassword} style={linkButtonStyle}>
          Forgot password
        </button>
        {error && (
          <p
            ref={errorRef}
            role="alert"
            aria-live="assertive"
            tabIndex={-1}
            className={styles.error}
          >
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
