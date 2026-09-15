// @react-navigation/native's NavigationContainer resolves Linking.getInitialURL() as a
// microtask during mount; without this flag that late state update warns "not configured to
// support act(...)" even though every assertion in a test already awaited settling via
// findBy*. Standard fix for RN + React Navigation + React 19's test renderer.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
