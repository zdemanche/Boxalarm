import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { X } from './icons';
import styles from './Toast.module.css';

interface ToastEntry {
  id: number;
  message: string;
  tone: 'default' | 'ok' | 'danger';
}

interface ToastContextValue {
  showToast: (message: string, tone?: ToastEntry['tone']) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

const AUTO_DISMISS_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, tone: ToastEntry['tone'] = 'default') => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, tone }]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={styles.viewport} role="status" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className={styles.toast} data-tone={t.tone}>
            <span>{t.message}</span>
            <button
              type="button"
              className={styles.dismiss}
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
