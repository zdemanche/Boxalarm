import { NavigationContainer } from '@react-navigation/native';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../auth/AuthContext';
import { SyncStatusBanner } from '../sync/SyncStatusBanner';
import { AppTabs } from './AppTabs';
import { AuthStack } from './AuthStack';
import { navigationRef } from './navigationRef';

export function RootNavigator() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return <View style={{ flex: 1 }} />;

  return (
    <NavigationContainer ref={navigationRef}>
      {isAuthenticated ? (
        <View style={{ flex: 1 }}>
          <SafeAreaView edges={['top']}>
            <SyncStatusBanner />
          </SafeAreaView>
          <AppTabs />
        </View>
      ) : (
        <AuthStack />
      )}
    </NavigationContainer>
  );
}
