import notifee, { AuthorizationStatus } from '@notifee/react-native';
import { Platform } from 'react-native';
import Config from 'react-native-config';
import messaging from '@react-native-firebase/messaging';
import type { DeviceToken, NativePushBridge } from './pushTokens';

async function readDeviceToken(): Promise<DeviceToken | null> {
  if (Platform.OS === 'ios') {
    await messaging().registerDeviceForRemoteMessages();
    const token = await messaging().getAPNSToken();
    return token ? { platform: 'APNS', token } : null;
  }
  const token = await messaging().getToken();
  return token ? { platform: 'FCM', token } : null;
}

export const firebaseNativePushBridge: NativePushBridge = {
  async requestPermission() {
    const criticalAlertsGranted = Config.CRITICAL_ALERTS_ENTITLEMENT_GRANTED === 'true';
    const settings = await notifee.requestPermission({
      ios: { critical: criticalAlertsGranted },
    });
    return (
      settings.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
      settings.authorizationStatus === AuthorizationStatus.PROVISIONAL
    );
  },

  getToken: readDeviceToken,

  onTokenRefresh(listener) {
    return messaging().onTokenRefresh(() => {
      void readDeviceToken().then((device) => {
        if (device) listener(device);
      });
    });
  },
};
