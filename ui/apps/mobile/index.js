import notifee from '@notifee/react-native';
import { getMessaging, setBackgroundMessageHandler } from '@react-native-firebase/messaging';
import { AppRegistry } from 'react-native';
import { App } from './src/App';
import { displayPushNotification } from './src/features/alerts/pushNotificationDisplay';
import { name as appName } from './app.json';

setBackgroundMessageHandler(getMessaging(), async (remoteMessage) => {
  await displayPushNotification(remoteMessage.data);
});

notifee.onBackgroundEvent(async () => {});

AppRegistry.registerComponent(appName, () => App);
