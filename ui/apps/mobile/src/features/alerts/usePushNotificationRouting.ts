import { useEffect } from 'react';
import { ensureNotificationChannels } from './pushChannel';
import { subscribePushNotificationRouting } from './pushRouting';

export function usePushNotificationRouting(): void {
  useEffect(() => {
    void ensureNotificationChannels();
    return subscribePushNotificationRouting();
  }, []);
}
