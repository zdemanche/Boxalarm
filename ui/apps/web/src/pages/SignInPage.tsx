import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { radius, typography } from '@boxalarm/design-tokens';
import { useAuth } from '../auth/AuthContext';
import { buildForgotPasswordUrl } from '../auth/config';
import { BrandMark } from '../components/BrandMark';
import { buttonClassName } from '../components/ui/Button';
import styles from './SignInPage.module.css';

// These two inline styles are pinned by SignInPage.test.tsx (design-token parity: the display
// type step for the wordmark, the amber accent fill and default radius for the one action) -
// keep the values, not just the intent, if this file changes again.
const headingStyle: CSSProperties = {
  fontSize: typography.size.display,
  margin: 0,
};

const buttonStyle: CSSProperties = {
  background: 'var(--bx-accent-fill)',
  color: 'var(--bx-on-accent-fill)',
  borderRadius: radius.default,
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
    <main id="main-content" className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <BrandMark className={styles.mark} />
          <h1 style={headingStyle} className={styles.wordmark}>
            Boxalarm
          </h1>
        </div>
        <p className={styles.tagline}>Sign in to your department&apos;s command console.</p>
        <div className={styles.actions}>
          <button
            type="button"
            onClick={handleSignIn}
            style={buttonStyle}
            className={[buttonClassName({ variant: 'primary', size: 'lg' }), styles.signIn].join(
              ' ',
            )}
          >
            Sign in
          </button>
          <button
            type="button"
            onClick={handleForgotPassword}
            className={buttonClassName({ variant: 'ghost', size: 'md' })}
          >
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
      </div>
      <p className={styles.footnote}>
        Fire department operations: alerting, the live roster, incident reports, apparatus, training
        and inspections.
      </p>
    </main>
  );
}
