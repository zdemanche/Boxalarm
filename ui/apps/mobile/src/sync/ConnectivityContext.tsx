import { createContext, useContext, useState, type ReactNode } from 'react';

// Real connectivity detection (RN NetInfo, per architecture.md's sync engine section) is
// @boxalarm/core's scope, not built yet. This models just the shape screens need - a single
// isOnline flag - so the sync banner and per-screen offline states (RosterScreen) can be built
// now and swap to real detection later without a UI rewrite.
export interface ConnectivityContextValue {
  isOnline: boolean;
}

const ConnectivityContext = createContext<ConnectivityContextValue | undefined>(undefined);

export function ConnectivityProvider({
  children,
  initialIsOnline = true,
}: {
  children: ReactNode;
  initialIsOnline?: boolean;
}) {
  const [isOnline] = useState(initialIsOnline);
  return (
    <ConnectivityContext.Provider value={{ isOnline }}>{children}</ConnectivityContext.Provider>
  );
}

export function useConnectivity(): ConnectivityContextValue {
  const ctx = useContext(ConnectivityContext);
  if (!ctx) throw new Error('useConnectivity must be used within ConnectivityProvider');
  return ctx;
}
