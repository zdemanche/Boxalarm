import { NavigationContainer } from '@react-navigation/native';
import { useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../auth/AuthContext';
import { SyncStatusBanner } from '../sync/SyncStatusBanner';
import { AppTabs } from './AppTabs';
import { AuthStack } from './AuthStack';
import { GlobalReadinessBanner } from '../features/alerts/GlobalReadinessBanner';
import { syncLockScreenPresentation } from '../features/alerts/lockScreenPresentation';
import { flushPendingAlertNavigation, navigationRef } from './navigationRef';

function onNavigationReady(): void {
  flushPendingAlertNavigation();
  syncLockScreenPresentation();
}

export function RootNavigator() {
  const { isAuthenticated, isLoading } = useAuth();
  const [focusedRouteName, setFocusedRouteName] = useState<string | undefined>();
  if (isLoading) return <View style={{ flex: 1 }} />;

  const onStateChange = () => {
    // A page opened while the sign-in screens showed opens once the tabs mount (M2).
    flushPendingAlertNavigation();
    setFocusedRouteName(navigationRef.getCurrentRoute()?.name);
    syncLockScreenPresentation();
  };

  return (
    <NavigationContainer
      ref={navigationRef}
      onReady={() => {
        onNavigationReady();
        setFocusedRouteName(navigationRef.getCurrentRoute()?.name);
      }}
      onStateChange={onStateChange}
    >
      {isAuthenticated ? (
        <View style={{ flex: 1 }}>
          <SafeAreaView edges={['top']}>
            <SyncStatusBanner />
            <GlobalReadinessBanner focusedRouteName={focusedRouteName} />
          </SafeAreaView>
          <AppTabs />
        </View>
      ) : (
        <AuthStack />
      )}
    </NavigationContainer>
  );
}
