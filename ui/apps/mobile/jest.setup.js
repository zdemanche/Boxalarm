// @react-navigation/native's NavigationContainer resolves Linking.getInitialURL() as a
// microtask during mount; without this flag that late state update warns "not configured to
// support act(...)" even though every assertion in a test already awaited settling via
// findBy*. Standard fix for RN + React Navigation + React 19's test renderer.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Native Config module is absent in Jest; any import of react-native-config (e.g. via
// apiChecksRepository → ApparatusPicker → ChecksStack → AppTabs) throws without this mock.
jest.mock('react-native-config', () => ({
  __esModule: true,
  default: {
    COGNITO_ISSUER: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
    COGNITO_NATIVE_CLIENT_ID: 'native-client',
    COGNITO_HOSTED_UI_ORIGIN: 'https://boxalarm.auth.us-east-1.amazoncognito.com',
    API_BASE_URL: '',
  },
}));

// No Firebase/notifee native modules are linked in Jest - every push-path test supplies its own
// jest.mock for these with the behavior it needs; this default keeps every other test (which
// only imports something that transitively pulls in the push modules) from crashing on load.
jest.mock('@react-native-firebase/messaging', () => {
  const instance = {
    getToken: jest.fn(async () => null),
    getAPNSToken: jest.fn(async () => null),
    registerDeviceForRemoteMessages: jest.fn(async () => undefined),
    onTokenRefresh: jest.fn(() => () => {}),
    onMessage: jest.fn(() => () => {}),
    onNotificationOpenedApp: jest.fn(() => () => {}),
    getInitialNotification: jest.fn(async () => null),
    setBackgroundMessageHandler: jest.fn(),
  };
  const messaging = () => instance;
  return { __esModule: true, default: messaging };
});

jest.mock('@notifee/react-native', () => {
  const instance = {
    createChannel: jest.fn(async () => undefined),
    requestPermission: jest.fn(async () => ({ authorizationStatus: 1 })),
    displayNotification: jest.fn(async () => undefined),
    getInitialNotification: jest.fn(async () => null),
    onForegroundEvent: jest.fn(() => () => {}),
    onBackgroundEvent: jest.fn(),
  };
  return {
    __esModule: true,
    default: instance,
    AndroidImportance: { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4 },
    AuthorizationStatus: { NOT_DETERMINED: -1, DENIED: 0, AUTHORIZED: 1, PROVISIONAL: 2 },
    EventType: { DISMISSED: 0, PRESS: 1, ACTION_PRESS: 2, DELIVERED: 3, APP_BLOCKED: 4 },
  };
});

// SafeAreaProvider reports insets via a native event listener that never fires in Jest, so it
// renders nothing without initialMetrics. @react-navigation/bottom-tabs reads the package's
// context object directly (not just its public hooks), so a full-module mock isn't safe - this
// keeps every real export and only forces a default initialMetrics onto SafeAreaProvider.
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  const { testSafeAreaMetrics } = require('./src/testUtils/safeAreaMetrics');
  const React = require('react');
  return {
    ...actual,
    SafeAreaProvider: (props) =>
      React.createElement(actual.SafeAreaProvider, {
        ...props,
        initialMetrics: props.initialMetrics ?? testSafeAreaMetrics,
      }),
  };
});
