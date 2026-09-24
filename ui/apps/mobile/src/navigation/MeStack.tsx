import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { CertificationsScreen } from '../screens/me/CertificationsScreen';
import { DiagnosticsScreen } from '../screens/me/DiagnosticsScreen';
import { InboxScreen } from '../screens/me/InboxScreen';
import { MeHomeScreen } from '../screens/me/MeHomeScreen';
import { NotificationPreferencesScreen } from '../screens/me/NotificationPreferencesScreen';
import { MyEquipmentScreen } from '../screens/me/MyEquipmentScreen';
import { MyPpeScreen } from '../screens/me/MyPpeScreen';
import { SelfTestScreen } from '../screens/me/SelfTestScreen';
import { TranscriptScreen } from '../screens/me/TranscriptScreen';

// Profile, certifications, transcript, inbox, preferences, self-test, diagnostics -
// architecture.md §7.2 MeStack.
export type MeStackParamList = {
  MeHome: undefined;
  Certifications: undefined;
  Transcript: undefined;
  Inbox: undefined;
  NotificationPreferences: undefined;
  MyEquipment: undefined;
  MyPpe: undefined;
  SelfTest: undefined;
  Diagnostics: undefined;
};

const Stack = createNativeStackNavigator<MeStackParamList>();

export function MeStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="MeHome" component={MeHomeScreen} options={{ title: 'Me' }} />
      <Stack.Screen name="Certifications" component={CertificationsScreen} />
      <Stack.Screen name="Transcript" component={TranscriptScreen} />
      <Stack.Screen name="Inbox" component={InboxScreen} options={{ title: 'Notifications' }} />
      <Stack.Screen
        name="NotificationPreferences"
        component={NotificationPreferencesScreen}
        options={{ title: 'Notification preferences' }}
      />
      <Stack.Screen
        name="MyEquipment"
        component={MyEquipmentScreen}
        options={{ title: 'My equipment' }}
      />
      <Stack.Screen name="MyPpe" component={MyPpeScreen} options={{ title: 'My PPE' }} />
      <Stack.Screen name="SelfTest" component={SelfTestScreen} options={{ title: 'Self-test' }} />
      <Stack.Screen name="Diagnostics" component={DiagnosticsScreen} />
    </Stack.Navigator>
  );
}
