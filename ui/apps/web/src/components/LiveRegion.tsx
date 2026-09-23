import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface LiveRegionContextValue {
  announce: (message: string) => void;
}

const LiveRegionContext = createContext<LiveRegionContextValue | undefined>(undefined);

export function LiveRegionProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');

  const announce = useCallback((next: string) => {
    // Clear then set so identical consecutive messages are re-announced.
    setMessage('');
    requestAnimationFrame(() => setMessage(next));
  }, []);

  const value = useMemo(() => ({ announce }), [announce]);

  return (
    <LiveRegionContext.Provider value={value}>
      {children}
      <div aria-live="polite" aria-atomic="true" className="visually-hidden">
        {message}
      </div>
    </LiveRegionContext.Provider>
  );
}

export function useLiveRegion(): LiveRegionContextValue {
  const ctx = useContext(LiveRegionContext);
  if (!ctx) throw new Error('useLiveRegion must be used within LiveRegionProvider');
  return ctx;
}
