import { act, renderHook } from '@testing-library/react-native';
import { mockAlertsRepository } from './mockAlertsRepository';
import { ACTIVE_LIST_REFRESH_MS, useActiveDispatches } from './useActiveDispatches';
import type { ActiveDispatchList } from './types';

const list = (id: string): ActiveDispatchList => ({
  dispatches: [
    {
      dispatchId: id,
      incidentType: 'MVA',
      address: `${id} Main St`,
      crossStreets: null,
      dispatchedAt: 1,
      toneSequence: 1,
    },
  ],
  asOf: 1,
  truncated: false,
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('an older request answering after a newer one is ignored (review m6)', async () => {
  let resolveFirst: (value: ActiveDispatchList) => void = () => {};
  const spy = jest
    .spyOn(mockAlertsRepository, 'listActiveDispatches')
    .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
    .mockResolvedValueOnce(list('NEW'));
  const { result } = await renderHook(() => useActiveDispatches(mockAlertsRepository));

  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.calls[0]?.dispatchId).toBe('NEW');

  await act(async () => {
    resolveFirst(list('OLD'));
  });

  expect(result.current.calls[0]?.dispatchId).toBe('NEW');
  expect(spy).toHaveBeenCalledTimes(2);
});

test('not visible: no polling; becoming visible loads and polls', async () => {
  jest.useFakeTimers();
  const spy = jest.spyOn(mockAlertsRepository, 'listActiveDispatches').mockResolvedValue(list('A'));
  const { rerender } = await renderHook(
    ({ visible }: { visible: boolean }) => useActiveDispatches(mockAlertsRepository, visible),
    { initialProps: { visible: false } },
  );

  await act(async () => {
    await jest.advanceTimersByTimeAsync(ACTIVE_LIST_REFRESH_MS * 3);
  });
  expect(spy).not.toHaveBeenCalled();

  await act(async () => {
    rerender({ visible: true });
  });
  expect(spy).toHaveBeenCalledTimes(1);
});
