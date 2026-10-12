import { DEMO_DISPATCH_ID, seedDemoAlerts } from './demoAlerts';
import { mockAlertsRepository } from './mockAlertsRepository';

// The Simulator demo opens on a live call so the page screen - the product's most important
// screen - can be seen without a backend (auth/demoMode.tsx).
test('seeding puts one live call in the mock alerting data, with its roster', async () => {
  seedDemoAlerts();
  const active = await mockAlertsRepository.listActiveDispatches();
  expect(active.dispatches.map((d) => d.dispatchId)).toContain(DEMO_DISPATCH_ID);
  const dispatch = await mockAlertsRepository.getDispatch(DEMO_DISPATCH_ID);
  expect(dispatch.isSelfTest).toBe(false);
  expect(dispatch.address).toBe('18 Nichols Ave');
  const roster = await mockAlertsRepository.getRoster(DEMO_DISPATCH_ID);
  expect(roster.length).toBeGreaterThan(1);
});

test('seeding twice does not duplicate the call', async () => {
  seedDemoAlerts();
  seedDemoAlerts();
  const active = await mockAlertsRepository.listActiveDispatches();
  expect(active.dispatches.filter((d) => d.dispatchId === DEMO_DISPATCH_ID)).toHaveLength(1);
});
