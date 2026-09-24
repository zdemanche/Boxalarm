import { createNavigationContainerRef } from '@react-navigation/native';
import type { AppTabsParamList } from './AppTabs';

export const navigationRef = createNavigationContainerRef<AppTabsParamList>();

export function navigateToAlertDetail(dispatchId: string): void {
  if (!navigationRef.isReady()) return;
  navigationRef.navigate('Alerts', { screen: 'AlertDetail', params: { dispatchId } });
}
