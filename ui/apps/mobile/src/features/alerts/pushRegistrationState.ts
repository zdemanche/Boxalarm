/**
 * Whether this phone is registered with the server for the signed-in member's pages (C1). Set by
 * usePushTokenRegistration for one sign-in at a time and read by the readiness checklist, so a
 * phone the server does not know about raises the red banner instead of showing ready.
 */
export type PushRegistrationStatus = 'registering' | 'registered' | 'failed' | 'permissionDenied';

export interface PushRegistrationState {
  readonly memberId: string;
  readonly status: PushRegistrationStatus;
}

let current: PushRegistrationState | null = null;
let retryNow: (() => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function getPushRegistration(): PushRegistrationState | null {
  return current;
}

/** Null when no sign-in is registering (signed out, or between sessions). */
export function setPushRegistration(next: PushRegistrationState | null): void {
  current = next;
  notify();
}

/** The registering session's "try now" (the readiness fix); null while none is running. */
export function setPushRegistrationRetry(retry: (() => void) | null): void {
  retryNow = retry;
}

export function retryPushRegistration(): void {
  retryNow?.();
}

export function subscribePushRegistration(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
