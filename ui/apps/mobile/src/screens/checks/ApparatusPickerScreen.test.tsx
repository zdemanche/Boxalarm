import { act, fireEvent, render } from '@testing-library/react-native';
import { mockChecksRepository } from '../../features/checks/mockChecksRepository';
import type { ChecksRepositoryWithFallbackFlag } from '../../features/checks/apiChecksRepository';
import { NoCachedDataError } from '../../sync/readThrough';
import { ApparatusPickerScreen } from './ApparatusPickerScreen';

const mockNavigate = jest.fn();
let mockRepository: ChecksRepositoryWithFallbackFlag = mockChecksRepository;

const mockFocusListeners: (() => void)[] = [];
const mockNavigation = {
  navigate: (...args: unknown[]) => mockNavigate(...args),
  addListener: (_event: string, listener: () => void) => {
    mockFocusListeners.push(listener);
    return () => {
      const index = mockFocusListeners.indexOf(listener);
      if (index >= 0) mockFocusListeners.splice(index, 1);
    };
  },
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
}));

let mockRoles: string[] = ['MEMBER'];
jest.mock('../../auth/AuthContext', () => ({
  useOptionalAuth: () => ({ roles: mockRoles }),
}));

jest.mock('../../features/checks/apiChecksRepository', () => ({
  useChecksRepository: () => mockRepository,
}));

beforeEach(() => {
  mockNavigate.mockClear();
  mockFocusListeners.length = 0;
  mockRepository = mockChecksRepository;
  mockRoles = ['MEMBER'];
});

test('an out-of-service unit can be checked, without promising the check returns it', async () => {
  const { findByText, queryByText } = await render(<ApparatusPickerScreen />);

  fireEvent.press(await findByText('TANKER-1'));
  expect(mockNavigate).toHaveBeenCalledWith('CheckRunner', { apparatusId: 'TANKER-1' });
  expect(await findByText('Out of service — you can still check it')).toBeTruthy();
  expect(queryByText(/return it to service/)).toBeNull();
});

test('roles Cedar allows get a service-status control per unit; members do not', async () => {
  mockRoles = ['OFFICER'];
  const { findByRole } = await render(<ApparatusPickerScreen />);

  fireEvent.press(await findByRole('button', { name: 'Return TANKER-1 to service' }));
  expect(mockNavigate).toHaveBeenCalledWith('ServiceStatus', {
    unitId: 'TANKER-1',
    status: 'OUT_OF_SERVICE',
  });
  fireEvent.press(await findByRole('button', { name: 'Take ENGINE-2 out of service' }));
  expect(mockNavigate).toHaveBeenCalledWith('ServiceStatus', {
    unitId: 'ENGINE-2',
    status: 'IN_SERVICE',
  });
});

test('a member sees no service-status control', async () => {
  const { findByText, queryByRole } = await render(<ApparatusPickerScreen />);

  await findByText('ENGINE-2');
  expect(queryByRole('button', { name: /out of service$|to service$/ })).toBeNull();
});

test('lists each apparatus with its unit id and status', async () => {
  const { findByText } = await render(<ApparatusPickerScreen />);

  expect(await findByText('ENGINE-2')).toBeTruthy();
  expect(await findByText('LADDER-1')).toBeTruthy();
});

test('selecting an in-service apparatus navigates to the check runner', async () => {
  const { findByText } = await render(<ApparatusPickerScreen />);

  fireEvent.press(await findByText('ENGINE-2'));
  expect(mockNavigate).toHaveBeenCalledWith('CheckRunner', { apparatusId: 'ENGINE-2' });
});

test('shows a loading state, not a blank list, while the list is on its way', async () => {
  mockRepository = { ...mockChecksRepository, getApparatus: () => new Promise(() => undefined) };
  const { findByText } = await render(<ApparatusPickerScreen />);

  expect(await findByText('Loading apparatus…')).toBeTruthy();
});

test('a list served from the phone cache says so, with its time', async () => {
  const cachedAt = new Date(2026, 8, 29, 14, 2).getTime();
  mockRepository = { ...mockChecksRepository, apparatusCachedAt: () => cachedAt };
  const { findByText } = await render(<ApparatusPickerScreen />);

  expect(await findByText(/Showing the apparatus list saved on this phone as of/)).toBeTruthy();
});

test('offline with nothing cached says so honestly and offers a retry, with no units shown', async () => {
  mockRepository = {
    ...mockChecksRepository,
    getApparatus: () => Promise.reject(new NoCachedDataError('the apparatus list')),
  };
  const { findByText, queryByText, getByText } = await render(<ApparatusPickerScreen />);

  expect(await findByText(/hasn't loaded the apparatus list yet/)).toBeTruthy();
  expect(queryByText('ENGINE-2')).toBeNull();
  expect(getByText('Try again')).toBeTruthy();
});

test('loads once on first focus, and again when the screen is focused on return', async () => {
  const getApparatus = jest.fn(mockChecksRepository.getApparatus);
  mockRepository = { ...mockChecksRepository, getApparatus };
  const { findByText } = await render(<ApparatusPickerScreen />);
  await findByText('ENGINE-2');

  await act(async () => {
    mockFocusListeners.forEach((listener) => listener()); // the initial focus
  });
  expect(getApparatus).toHaveBeenCalledTimes(1);

  await act(async () => {
    mockFocusListeners.forEach((listener) => listener()); // back from service status
  });
  expect(getApparatus).toHaveBeenCalledTimes(2);
});
