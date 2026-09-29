import notifee from '@notifee/react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { navigationRef } from '../../navigation/navigationRef';
import { GlobalReadinessBanner } from './GlobalReadinessBanner';

const getNotificationSettings = notifee.getNotificationSettings as jest.Mock;

afterEach(() => {
  getNotificationSettings.mockReset().mockResolvedValue({ authorizationStatus: 1 });
  jest.restoreAllMocks();
});

test('on any tab, a phone that cannot be paged shows the red banner with 72 dp fix targets', async () => {
  getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 });
  const { findByText, findByRole } = await render(
    <GlobalReadinessBanner focusedRouteName="ShiftBoard" />,
  );

  expect(await findByText(/This phone may not wake you for a page/)).toBeTruthy();
  const fix = await findByRole('button', { name: 'Fix: Notifications' });
  const seeAll = await findByRole('button', { name: 'See all alert readiness checks' });
  expect(fix.props.style.minHeight).toBeGreaterThanOrEqual(72);
  expect(seeAll.props.style.minHeight).toBeGreaterThanOrEqual(72);
});

test('See all opens the self-test checklist in the Me tab', async () => {
  getNotificationSettings.mockResolvedValue({ authorizationStatus: 2 });
  jest.spyOn(navigationRef, 'isReady').mockReturnValue(true);
  const navigate = jest.spyOn(navigationRef, 'navigate').mockImplementation(() => {});
  const { findByRole } = await render(<GlobalReadinessBanner focusedRouteName="AlertsHome" />);

  fireEvent.press(await findByRole('button', { name: 'See all alert readiness checks' }));

  expect(navigate).toHaveBeenCalledWith('Me', { screen: 'SelfTest' });
});

test('hidden while a call is on screen - the address and answers come first', async () => {
  getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 });
  const { queryByText, findByText, rerender } = await render(
    <GlobalReadinessBanner focusedRouteName="AlertsHome" />,
  );
  expect(await findByText(/This phone may not wake you for a page/)).toBeTruthy();

  await act(async () => {
    await rerender(<GlobalReadinessBanner focusedRouteName="AlertDetail" />);
  });

  expect(queryByText(/This phone may not wake you for a page/)).toBeNull();
});

test('a ready phone shows no banner', async () => {
  const { queryByText } = await render(<GlobalReadinessBanner focusedRouteName="MeHome" />);
  await act(async () => {});

  expect(queryByText(/This phone may not wake you for a page/)).toBeNull();
});
