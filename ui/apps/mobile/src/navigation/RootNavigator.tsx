import { NavigationContainer } from '@react-navigation/native';
import { View } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { AppTabs } from './AppTabs';
import { AuthStack } from './AuthStack';

export function RootNavigator() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return <View style={{ flex: 1 }} />;

  return <NavigationContainer>{isAuthenticated ? <AppTabs /> : <AuthStack />}</NavigationContainer>;
}
