import type { LinkingOptions } from '@react-navigation/native';
import { Linking, Platform, Settings } from 'react-native';
import type { AppTabsParamList } from './AppTabs';

/**
 * `xcrun simctl launch booted com.boxalarm.mobile -demoRoute me/inbox` starts the demo on that
 * screen: iOS puts launch arguments in NSUserDefaults, which RN's Settings module reads. Unlike
 * `simctl openurl`, it raises no "Open in Boxalarm?" prompt.
 */
export function demoRouteUrl(): string | null {
  if (Platform.OS !== 'ios') return null;
  const route: unknown = Settings.get('demoRoute');
  return typeof route === 'string' && route.length > 0 ? `boxalarm://demo/${route}` : null;
}

/**
 * Deep links for the Simulator demo only (auth/demoMode.tsx): `xcrun simctl openurl booted
 * boxalarm://demo/me/inbox` opens a screen without tapping, for walkthroughs and screenshots.
 * RootNavigator passes this only when isDemoMode(), and only `boxalarm://demo` URLs match, so the
 * real sign-in callback (`boxalarm://auth`) is never claimed by navigation.
 */
export const DEMO_LINKING: LinkingOptions<AppTabsParamList> = {
  prefixes: ['boxalarm://demo'],
  getInitialURL: async () => demoRouteUrl() ?? (await Linking.getInitialURL()),
  config: {
    screens: {
      Alerts: {
        screens: {
          AlertsHome: 'alerts',
          ManualEntry: 'alerts/manual',
          ReportDispatches: 'alerts/reports',
          AlertDetail: 'alerts/:dispatchId',
          Roster: 'alerts/:dispatchId/roster',
          RidingBoard: 'alerts/:dispatchId/riding',
          MutualAidPrompt: 'alerts/:dispatchId/mutual-aid',
        },
      },
      Checks: {
        screens: {
          ApparatusPicker: 'apparatus',
          FieldCapture: 'apparatus/capture',
          CheckRunner: 'apparatus/:apparatusId/check',
          DefectReport: 'apparatus/:apparatusId/defect',
          ServiceStatus: 'apparatus/:unitId/status',
        },
      },
      Schedule: {
        screens: {
          ShiftBoard: 'schedule',
          Availability: 'schedule/availability',
          TrainingEvents: 'schedule/training',
          ShiftDetail: 'schedule/:shiftId',
        },
      },
      Me: {
        screens: {
          MeHome: 'me',
          Availability: 'me/availability',
          ProfileEdit: 'me/profile',
          Attendance: 'me/attendance',
          Certifications: 'me/certifications',
          Transcript: 'me/transcript',
          Inbox: 'me/inbox',
          NotificationPreferences: 'me/notifications',
          MyEquipment: 'me/equipment',
          MyPpe: 'me/ppe',
          SelfTest: 'me/self-test',
          Diagnostics: 'me/diagnostics',
        },
      },
    },
  },
};
