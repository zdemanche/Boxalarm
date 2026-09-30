import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ApparatusPickerScreen } from '../screens/checks/ApparatusPickerScreen';
import { CheckRunnerScreen } from '../screens/checks/CheckRunnerScreen';
import { DefectReportScreen } from '../screens/checks/DefectReportScreen';
import { FieldCaptureScreen } from '../screens/checks/FieldCaptureScreen';
import { ServiceStatusScreen } from '../screens/checks/ServiceStatusScreen';
import type { ApparatusStatus } from '../features/checks/types';
import { SERVICE_STATUS_ROLES } from '../features/checks/serviceStatusApi';
import { RequireRole } from './RequireRole';

// Apparatus picker, check runner, defect report - architecture.md §7.2 ChecksStack.
// FieldCapture (E5-S7) has no stack of its own in §7.2, so it hangs off Checks per that
// ticket's scope note.
export type ChecksStackParamList = {
  ApparatusPicker: undefined;
  CheckRunner: { apparatusId: string };
  DefectReport: { apparatusId: string };
  FieldCapture: undefined;
  /** Take a unit out of service or return it; `status` is its status when opened. */
  ServiceStatus: { unitId: string; status: ApparatusStatus };
};

const Stack = createNativeStackNavigator<ChecksStackParamList>();

export function ChecksStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen
        name="ApparatusPicker"
        component={ApparatusPickerScreen}
        options={{ title: 'Apparatus' }}
      />
      <Stack.Screen name="CheckRunner" component={CheckRunnerScreen} options={{ title: 'Check' }} />
      <Stack.Screen
        name="DefectReport"
        component={DefectReportScreen}
        options={{ title: 'Report defect' }}
      />
      <Stack.Screen
        name="FieldCapture"
        component={FieldCaptureScreen}
        options={{ title: 'Field capture' }}
      />
      <Stack.Screen name="ServiceStatus" options={{ title: 'Service status' }}>
        {() => (
          <RequireRole roles={SERVICE_STATUS_ROLES}>
            <ServiceStatusScreen />
          </RequireRole>
        )}
      </Stack.Screen>
    </Stack.Navigator>
  );
}
