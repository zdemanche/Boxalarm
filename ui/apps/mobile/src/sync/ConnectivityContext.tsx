import NetInfo from '@react-native-community/netinfo';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export interface ConnectivityContextValue {
  isOnline: boolean;
}

const ConnectivityContext = createContext<ConnectivityContextValue | undefined>(undefined);

/** `initialIsOnline` forces a fixed value (used by tests and any screen that needs to exercise
 * the offline state deterministically); when omitted, isOnline tracks real NetInfo state. */
export function ConnectivityProvider({
  children,
  initialIsOnline,
}: {
  children: ReactNode;
  initialIsOnline?: boolean;
}) {
  const [isOnline, setIsOnline] = useState(initialIsOnline ?? true);

  useEffect(() => {
    if (initialIsOnline !== undefined) return;
    const unsubscribe = NetInfo.addEventListener((state) => {
      setIsOnline(state.isConnected === true);
    });
    NetInfo.fetch().then((state) => setIsOnline(state.isConnected === true));
    return unsubscribe;
  }, [initialIsOnline]);

  return (
    <ConnectivityContext.Provider value={{ isOnline }}>{children}</ConnectivityContext.Provider>
  );
}

export function useConnectivity(): ConnectivityContextValue {
  const ctx = useContext(ConnectivityContext);
  if (!ctx) throw new Error('useConnectivity must be used within ConnectivityProvider');
  return ctx;
}

/** Defaults to online outside ConnectivityProvider (e.g. a screen unit test with no providers),
 * matching useOptionalAuth's degrade-gracefully pattern for data hooks. */
export function useOptionalConnectivity(): ConnectivityContextValue {
  return useContext(ConnectivityContext) ?? { isOnline: true };
}
