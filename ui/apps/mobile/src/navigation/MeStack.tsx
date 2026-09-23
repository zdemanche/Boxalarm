import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AttendanceScreen } from '../screens/me/AttendanceScreen';
import { CertificationsScreen } from '../screens/me/CertificationsScreen';
import { DiagnosticsScreen } from '../screens/me/DiagnosticsScreen';
import { MeHomeScreen } from '../screens/me/MeHomeScreen';
import { ProfileEditScreen } from '../screens/me/ProfileEditScreen';
import { SelfTestScreen } from '../screens/me/SelfTestScreen';

// Profile, certifications, self-test, diagnostics - architecture.md §7.2 MeStack.
export type MeStackParamList = {
  MeHome: undefined;
  ProfileEdit: undefined;
  Attendance: undefined;
  Certifications: undefined;
  SelfTest: undefined;
  Diagnostics: undefined;
};

const Stack = createNativeStackNavigator<MeStackParamList>();

export function MeStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="MeHome" component={MeHomeScreen} options={{ title: 'Me' }} />
      <Stack.Screen
        name="ProfileEdit"
        component={ProfileEditScreen}
        options={{ title: 'Edit profile' }}
      />
      <Stack.Screen
        name="Attendance"
        component={AttendanceScreen}
        options={{ title: 'Attendance' }}
      />
      <Stack.Screen name="Certifications" component={CertificationsScreen} />
      <Stack.Screen name="SelfTest" component={SelfTestScreen} options={{ title: 'Self-test' }} />
      <Stack.Screen name="Diagnostics" component={DiagnosticsScreen} />
    </Stack.Navigator>
  );
}
