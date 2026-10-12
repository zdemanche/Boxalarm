import { getStateFromPath } from '@react-navigation/native';
import { Settings } from 'react-native';
import { DEMO_LINKING, demoRouteUrl } from './demoLinking';

function routeNames(path: string): string[] {
  const names: string[] = [];
  let state = getStateFromPath(path, DEMO_LINKING.config) as
    { routes: { name: string; state?: unknown }[] } | undefined;
  while (state) {
    const route = state.routes[state.routes.length - 1]!;
    names.push(route.name);
    state = route.state as typeof state;
  }
  return names;
}

describe('demo deep links', () => {
  test.each([
    ['alerts', ['Alerts', 'AlertsHome']],
    ['apparatus', ['Checks', 'ApparatusPicker']],
    ['schedule/training', ['Schedule', 'TrainingEvents']],
    ['me/inbox', ['Me', 'Inbox']],
  ])('%s opens %j', (path, names) => {
    expect(routeNames(path)).toEqual(names);
  });

  // The sign-in callback (boxalarm://auth) must never be claimed by navigation.
  test('only URLs under the demo prefix are handled', () => {
    expect(DEMO_LINKING.prefixes).toEqual(['boxalarm://demo']);
  });
});

test('a -demoRoute launch argument becomes the initial demo URL', () => {
  const get = jest.spyOn(Settings, 'get').mockReturnValue('me/inbox');
  expect(demoRouteUrl()).toBe('boxalarm://demo/me/inbox');
  get.mockReturnValue(undefined);
  expect(demoRouteUrl()).toBeNull();
  get.mockRestore();
});
