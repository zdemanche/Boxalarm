import { useEffect, useState } from 'react';

/**
 * Browser network reachability only — `navigator.onLine` plus the `online`/`offline` window
 * events. This does NOT reflect whether the Boxalarm API, the alerting backend, or dispatch is
 * reachable; a browser can report `online` while every one of those is down. Callers must label
 * it accordingly (see TopBar) rather than presenting it as general "connected" status — a false
 * "Connected" claim in a life-safety dispatch app was PR #318 review MAJOR-2.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
