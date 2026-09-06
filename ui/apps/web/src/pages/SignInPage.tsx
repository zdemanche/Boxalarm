import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { palette, spacing } from '@boxalarm/design-tokens';
import { useAuth } from '../auth/AuthContext';

const containerStyle = {
  '--sign-in-bg-day': palette.day.background,
  '--sign-in-fg-day': palette.day.foreground,
  '--sign-in-bg-cab': palette.cab.background,
  '--sign-in-fg-cab': palette.cab.foreground,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '100vh',
  gap: spacing.lg,
  padding: spacing.lg,
} as CSSProperties;

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

  return (
    <>
      <style>{`
        .boxalarm-sign-in { background: var(--sign-in-bg-day); color: var(--sign-in-fg-day); }
        @media (prefers-color-scheme: dark) {
          .boxalarm-sign-in { background: var(--sign-in-bg-cab); color: var(--sign-in-fg-cab); }
        }
      `}</style>
      <main className="boxalarm-sign-in" style={containerStyle}>
        <h1>Boxalarm</h1>
        <button
          type="button"
          onClick={handleSignIn}
          style={{
            minWidth: 220,
            minHeight: 56,
            fontSize: '1.25rem',
            padding: `${spacing.md}px ${spacing.lg}px`,
          }}
        >
          Sign in
        </button>
        {error && (
          <p ref={errorRef} role="alert" aria-live="assertive" tabIndex={-1}>
            {error}
          </p>
        )}
      </main>
    </>
  );
}
