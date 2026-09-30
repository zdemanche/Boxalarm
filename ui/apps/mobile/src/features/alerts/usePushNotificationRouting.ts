import { useEffect } from 'react';
import { AppState } from 'react-native';
import { registerNotificationCategories } from './notificationActions';
import { ensureNotificationChannels } from './pushChannel';
import { subscribePushNotificationRouting } from './pushRouting';

function ensureChannels(): void {
  ensureNotificationChannels({ deleteStale: true }).catch((error: unknown) => {
    console.error('[push] creating notification channels failed', error);
  });
}

export function usePushNotificationRouting(): void {
  useEffect(() => {
    ensureChannels();
    void registerNotificationCategories();
    // Returning from Settings is when a Do Not Disturb grant becomes usable: the critical
    // channel must be recreated under its -dnd id then (channels are immutable).
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') ensureChannels();
    });
    const unsubscribeRouting = subscribePushNotificationRouting();
    return () => {
      subscription.remove();
      unsubscribeRouting();
    };
  }, []);
}
