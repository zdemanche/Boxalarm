import { fireEvent, render } from '@testing-library/react-native';
import { mockChecksRepository } from '../../features/checks/mockChecksRepository';
import type { ChecksRepositoryWithFallbackFlag } from '../../features/checks/apiChecksRepository';
import { NoCachedDataError } from '../../sync/readThrough';
import { ApparatusPickerScreen } from './ApparatusPickerScreen';

const mockNavigate = jest.fn();
let mockRepository: ChecksRepositoryWithFallbackFlag = mockChecksRepository;

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock('../../features/checks/apiChecksRepository', () => ({
  useChecksRepository: () => mockRepository,
}));

beforeEach(() => {
  mockNavigate.mockClear();
  mockRepository = mockChecksRepository;
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
