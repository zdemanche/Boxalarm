import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ApparatusPickerScreen } from '../screens/checks/ApparatusPickerScreen';
import { CheckRunnerScreen } from '../screens/checks/CheckRunnerScreen';
import { DefectReportScreen } from '../screens/checks/DefectReportScreen';

// Apparatus picker, check runner, defect report - architecture.md §7.2 ChecksStack.
export type ChecksStackParamList = {
  ApparatusPicker: undefined;
  CheckRunner: { apparatusId: string };
  DefectReport: { apparatusId: string };
};

const Stack = createNativeStackNavigator<ChecksStackParamList>();

export function ChecksStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen
        name="ApparatusPicker"
        component={ApparatusPickerScreen}
        options={{ title: 'Checks' }}
      />
      <Stack.Screen name="CheckRunner" component={CheckRunnerScreen} options={{ title: 'Check' }} />
      <Stack.Screen
        name="DefectReport"
        component={DefectReportScreen}
        options={{ title: 'Report defect' }}
      />
    </Stack.Navigator>
  );
}
