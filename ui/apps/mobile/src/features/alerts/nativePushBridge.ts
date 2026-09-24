import notifee, { AuthorizationStatus } from '@notifee/react-native';
import { Platform } from 'react-native';
import Config from 'react-native-config';
import {
  getAPNSToken,
  getMessaging,
  getToken,
  onTokenRefresh,
  registerDeviceForRemoteMessages,
} from '@react-native-firebase/messaging';
import type { DeviceToken, NativePushBridge } from './pushTokens';

const messagingInstance = getMessaging();

async function readDeviceToken(): Promise<DeviceToken | null> {
  if (Platform.OS === 'ios') {
    await registerDeviceForRemoteMessages(messagingInstance);
    const token = await getAPNSToken(messagingInstance);
    return token ? { platform: 'APNS', token } : null;
  }
  const token = await getToken(messagingInstance);
  return token ? { platform: 'FCM', token } : null;
}

export const firebaseNativePushBridge: NativePushBridge = {
  async requestPermission() {
    const criticalAlertsGranted = Config.CRITICAL_ALERTS_ENTITLEMENT_GRANTED === 'true';
    const settings = await notifee.requestPermission({
      criticalAlert: criticalAlertsGranted,
    });
    return (
      settings.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
      settings.authorizationStatus === AuthorizationStatus.PROVISIONAL
    );
  },

  getToken: readDeviceToken,

  onTokenRefresh(listener) {
    return onTokenRefresh(messagingInstance, () => {
      void readDeviceToken().then((device) => {
        if (device) listener(device);
      });
    });
  },
};
