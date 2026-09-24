import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { X } from './icons';
import styles from './Toast.module.css';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastEntry {
  id: number;
  message: string;
  tone: 'default' | 'ok' | 'danger';
  action?: ToastAction;
}

interface ToastContextValue {
  /** `action` is a single optional control (e.g. "Undo") rendered alongside Dismiss.
   * README.md already told consumers to prefer "a toast with an action" over a ConfirmDialog
   * for a reversible action — this is that API, previously documented but not implemented. */
  showToast: (message: string, tone?: ToastEntry['tone'], action?: ToastAction) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

const AUTO_DISMISS_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Auto-dismiss timers used to be fired-and-forgotten: an unmount before the 6s elapsed still
  // scheduled a setState on the (by then unmounted) provider. Track them so they can be cleared
  // both on an early manual dismiss (above) and on unmount (below).
  useEffect(() => {
    const timerMap = timers.current;
    return () => {
      for (const timer of timerMap.values()) clearTimeout(timer);
      timerMap.clear();
    };
  }, []);

  const showToast = useCallback(
    (message: string, tone: ToastEntry['tone'] = 'default', action?: ToastAction) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, tone, action }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), AUTO_DISMISS_MS),
      );
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
            <div className={styles.actions}>
              {t.action ? (
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => {
                    t.action!.onClick();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              ) : null}
              <button
                type="button"
                className={styles.dismiss}
                aria-label="Dismiss"
                onClick={() => dismiss(t.id)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
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
