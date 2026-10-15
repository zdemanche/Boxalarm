import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { safeReturnPath } from '../routing/returnTo';

export function AuthCallbackPage() {
  const { completeSignIn, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  const hasRunRef = useRef(false);

  useEffect(() => {
    if (hasRunRef.current) return;
    hasRunRef.current = true;

    completeSignIn()
      .then((user) => {
        if (user) navigate(safeReturnPath(user.state), { replace: true });
      })
      .catch(() => setFailed(true));
  }, [completeSignIn, navigate]);

  if (failed && isAuthenticated) return <Navigate to="/" replace />;

  return (
    <main>
      <p role="status" aria-live="polite">
        {failed ? 'Sign-in could not be completed.' : 'Completing sign-in…'}
      </p>
      {failed && <Link to="/login">Sign in again</Link>}
    </main>
  );
}
