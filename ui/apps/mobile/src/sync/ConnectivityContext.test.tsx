import { render } from '@testing-library/react-native';
import { Text } from 'react-native';
import { ConnectivityProvider, useConnectivity } from './ConnectivityContext';

function ConnectivityProbe() {
  const { isOnline } = useConnectivity();
  return <Text>{isOnline ? 'online' : 'offline'}</Text>;
}

test('defaults to online - real NetInfo detection is @boxalarm/core scope, not built yet', async () => {
  const { findByText } = await render(
    <ConnectivityProvider>
      <ConnectivityProbe />
    </ConnectivityProvider>,
  );

  expect(await findByText('online')).toBeTruthy();
});

test('can be forced offline for screens/tests that need to exercise the offline state', async () => {
  const { findByText } = await render(
    <ConnectivityProvider initialIsOnline={false}>
      <ConnectivityProbe />
    </ConnectivityProvider>,
  );

  expect(await findByText('offline')).toBeTruthy();
});
