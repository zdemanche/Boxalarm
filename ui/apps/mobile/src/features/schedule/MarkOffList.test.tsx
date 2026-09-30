import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';
import { useScheduleRepository } from './apiScheduleRepository';
import { ApiError } from '../../lib/apiClient';
import { MarkOffList, resetMarkOffSupportForTest } from './MarkOffList';
import { MarkOffNeedsConnectionError } from './types';

jest.mock('./apiScheduleRepository', () => ({ useScheduleRepository: jest.fn() }));
jest.mock('../../sync/ConnectivityContext', () => ({ useOptionalConnectivity: jest.fn() }));
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({}) }));

const now = () => Math.floor(Date.now() / 1000);
let repository: { listMarkOffs: jest.Mock; endMarkOff: jest.Mock };

function online(isOnline: boolean) {
  (useOptionalConnectivity as jest.Mock).mockReturnValue({ isOnline });
}

beforeEach(() => {
  resetMarkOffSupportForTest();
  online(true);
  repository = {
    listMarkOffs: jest.fn(async () => [
      { markoffId: 'active-1', startAt: now() - 3600, endAt: now() + 3600, reason: 'Work' },
      { markoffId: 'later-1', startAt: now() + 86400, endAt: now() + 2 * 86400 },
    ]),
    endMarkOff: jest.fn(async () => undefined),
  };
  (useScheduleRepository as jest.Mock).mockReturnValue(repository);
});

test('shows current and upcoming mark-offs; "I\'m available again" ends the current one', async () => {
  await render(<MarkOffList />);

  expect(await screen.findByText(/^Marked unavailable until .* \(Work\)$/)).toBeTruthy();
  expect(screen.getByText(/^Unavailable from .* until/)).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Cancel this mark-off/ })).toBeTruthy();

  repository.listMarkOffs.mockResolvedValueOnce([
    { markoffId: 'later-1', startAt: now() + 86400, endAt: now() + 2 * 86400 },
  ]);
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: /^I'm available again/ }));
  });

  expect(repository.endMarkOff).toHaveBeenCalledWith(
    expect.objectContaining({ markoffId: 'active-1' }),
  );
  expect(
    await screen.findByText("You're available again. You'll be alerted for calls."),
  ).toBeTruthy();
  expect(screen.queryByText(/^Marked unavailable until/)).toBeNull();
});

test('offline: the list says it cannot be shown, and nothing is sent', async () => {
  // Once the server has shown it supports mark-offs...
  const first = await render(<MarkOffList />);
  await screen.findByText(/^Marked unavailable until/);
  await first.unmount();
  repository.listMarkOffs.mockClear();
  online(false);
  await render(<MarkOffList />);

  expect(
    await screen.findByText(/You're offline, so your current mark-offs can't be shown/),
  ).toBeTruthy();
  expect(repository.listMarkOffs).not.toHaveBeenCalled();
  expect(repository.endMarkOff).not.toHaveBeenCalled();
});

test('signal lost before ending: says plainly the member is still marked off', async () => {
  repository.endMarkOff.mockRejectedValueOnce(new MarkOffNeedsConnectionError());
  await render(<MarkOffList />);
  await screen.findByText(/^Marked unavailable until/);

  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: /^I'm available again/ }));
  });

  expect(await screen.findByText(/you're still marked unavailable/)).toBeTruthy();
});

test('a server failure says the mark-off still stands, until when', async () => {
  repository.endMarkOff.mockRejectedValueOnce(new Error('503'));
  await render(<MarkOffList />);
  await screen.findByText(/^Marked unavailable until/);

  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: /^I'm available again/ }));
  });

  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByText(/Couldn't end it - you're still marked unavailable until/)).toBeTruthy();
});

test('no mark-offs: nothing is shown', async () => {
  repository.listMarkOffs.mockResolvedValue([]);
  await render(<MarkOffList />);
  await act(async () => {});

  expect(screen.toJSON()).toBeNull();
});

// R3-M1: the app ships on its own cadence; a server without the routes answers 404/405.
test.each([404, 405])(
  'a server without the mark-off routes (%i): nothing is shown or promised',
  async (status) => {
    repository.listMarkOffs.mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Not Found', status, traceId: 't' }),
    );
    const onSupportKnown = jest.fn();
    await render(<MarkOffList onSupportKnown={onSupportKnown} />);
    await act(async () => {});

    expect(onSupportKnown).toHaveBeenCalledWith(false);
    expect(screen.toJSON()).toBeNull();
  },
);

test('offline before the server was ever seen to support it: nothing is promised', async () => {
  online(false);
  await render(<MarkOffList />);
  await act(async () => {});

  expect(screen.toJSON()).toBeNull();
});

test('a timeout on ending says it may or may not have ended, not "still marked unavailable"', async () => {
  const { ApiTimeoutError } = jest.requireActual('../../lib/apiClient');
  repository.endMarkOff.mockRejectedValueOnce(new ApiTimeoutError(15_000));
  await render(<MarkOffList />);
  await screen.findByText(/^Marked unavailable until/);

  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: /^I'm available again/ }));
  });

  expect(await screen.findByText(/it may or may not have ended\. Check again/)).toBeTruthy();
  expect(screen.queryByText(/still marked unavailable/)).toBeNull();
});
