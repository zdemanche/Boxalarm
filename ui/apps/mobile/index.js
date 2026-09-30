import notifee from '@notifee/react-native';
import {
  getMessaging,
  onMessage,
  setBackgroundMessageHandler,
} from '@react-native-firebase/messaging';
import { AppRegistry } from 'react-native';
import { App } from './src/App';
import { handleNotificationEvent } from './src/features/alerts/notificationActions';
import {
  handleBackgroundPushMessage,
  handleForegroundPushMessage,
} from './src/features/alerts/pushNotificationDisplay';
import { name as appName } from './app.json';

// handleBackgroundPushMessage never throws: a failed display is logged and a dispatch falls back to
// a minimal critical-channel notification instead of being silently dropped.
setBackgroundMessageHandler(getMessaging(), async (remoteMessage) => {
  await handleBackgroundPushMessage(remoteMessage?.data);
});

// Data-only pushes reach onMessage, not the background handler, while the app is open. Without
// this, a dispatch arriving with Boxalarm in the foreground is never displayed. Registered at
// module load (app start), before any screen mounts, for the lifetime of the JS runtime.
onMessage(getMessaging(), async (remoteMessage) => {
  await handleForegroundPushMessage(remoteMessage?.data);
});

// Responding / Not responding pressed on a page's notification while the app is in the
// background or not running: answered headlessly through the same offline queue as the app.
notifee.onBackgroundEvent(handleNotificationEvent);

AppRegistry.registerComponent(appName, () => App);
