import { AppRegistry } from 'react-native';
import { App } from './src/App';

jest.mock('react-native', () => ({ AppRegistry: { registerComponent: jest.fn() } }));
jest.mock('./src/App', () => ({
  App: function MockApp() {
    return null;
  },
}));

import './index';

test('registers the root App component under the app.json display name', () => {
  const registerComponent = AppRegistry.registerComponent as jest.Mock;
  expect(registerComponent).toHaveBeenCalledTimes(1);

  const [name, factory] = registerComponent.mock.calls[0] as [string, () => unknown];
  expect(name).toBe('Boxalarm');
  expect(factory()).toBe(App);
});
