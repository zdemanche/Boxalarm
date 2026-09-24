import notifee, { EventType } from '@notifee/react-native';
import { Platform } from 'react-native';
import {
  getInitialNotification,
  getMessaging,
  onNotificationOpenedApp,
} from '@react-native-firebase/messaging';
import { navigateToAlertDetail } from '../../navigation/navigationRef';

const messagingInstance = getMessaging();

export function dispatchIdFromNotificationData(
  data: Record<string, unknown> | undefined,
): string | null {
  const id = data?.dispatchId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

async function routeToInitialNotification(): Promise<void> {
  if (Platform.OS === 'android') {
    const initial = await notifee.getInitialNotification();
    const dispatchId = dispatchIdFromNotificationData(initial?.notification.data);
    if (dispatchId) navigateToAlertDetail(dispatchId);
    return;
  }
  const initial = await getInitialNotification(messagingInstance);
  const dispatchId = dispatchIdFromNotificationData(initial?.data);
  if (dispatchId) navigateToAlertDetail(dispatchId);
}

export function subscribePushNotificationRouting(): () => void {
  void routeToInitialNotification();

  const unsubscribeOpened = onNotificationOpenedApp(messagingInstance, (remoteMessage) => {
    const dispatchId = dispatchIdFromNotificationData(remoteMessage?.data);
    if (dispatchId) navigateToAlertDetail(dispatchId);
  });

  const unsubscribeForeground = notifee.onForegroundEvent(({ type, detail }) => {
    if (type !== EventType.PRESS) return;
    const dispatchId = dispatchIdFromNotificationData(detail.notification?.data);
    if (dispatchId) navigateToAlertDetail(dispatchId);
  });

  return () => {
    unsubscribeOpened();
    unsubscribeForeground();
  };
}
