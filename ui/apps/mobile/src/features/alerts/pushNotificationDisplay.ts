import notifee, { AndroidImportance } from '@notifee/react-native';
import { Platform } from 'react-native';
import { categoryFromPushData, channelForCategory } from './pushChannel';

export interface PushMessageData {
  category?: string;
  dispatchId?: string;
  title?: string;
  body?: string;
}

export async function displayPushNotification(data: PushMessageData | undefined): Promise<void> {
  if (Platform.OS !== 'android') return;

  const category = categoryFromPushData(data);
  const isCritical = category === 'dispatch';
  const channelId = channelForCategory(category);

  await notifee.displayNotification({
    title: data?.title ?? (isCritical ? 'Dispatch alert' : 'Notification'),
    body: data?.body,
    data: { dispatchId: data?.dispatchId ?? '', category },
    android: {
      channelId,
      importance: isCritical ? AndroidImportance.HIGH : AndroidImportance.DEFAULT,
      pressAction: { id: 'default' },
      ...(isCritical ? { fullScreenAction: { id: 'default' } } : {}),
    },
  });
}
