import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function AuthCallbackPage() {
  const { completeSignIn } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState('Completing sign-in…');
  const hasRunRef = useRef(false);

  useEffect(() => {
    if (hasRunRef.current) return;
    hasRunRef.current = true;
    let cancelled = false;

    completeSignIn()
      .then((user) => {
        if (!cancelled && user) navigate('/', { replace: true });
      })
      .catch(() => {
        if (!cancelled) setStatus('Sign-in could not be completed.');
      });

    return () => {
      cancelled = true;
    };
  }, [completeSignIn, navigate]);

  return (
    <main>
      <p role="status" aria-live="polite">
        {status}
      </p>
    </main>
  );
}
