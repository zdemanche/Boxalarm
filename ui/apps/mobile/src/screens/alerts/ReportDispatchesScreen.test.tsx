import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { apiRequest } from '../../lib/apiClient';
import { ReportDispatchesScreen } from './ReportDispatchesScreen';

jest.mock('../../lib/apiClient', () => ({
  ...jest.requireActual('../../lib/apiClient'),
  apiRequest: jest.fn(),
}));
jest.mock('react-native-config', () => ({
  __esModule: true,
  default: { API_BASE_URL: 'https://api.example.com' },
}));
let mockAuth: { roles: string[]; getAccessToken: jest.Mock; renewSilently: jest.Mock } | undefined;
jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: () => mockAuth }));
let mockOnline = true;
jest.mock('../../sync/ConnectivityContext', () => ({
  useOptionalConnectivity: () => ({ isOnline: mockOnline }),
}));

const mockApiRequest = apiRequest as jest.Mock;
const now = Math.floor(Date.now() / 1000);

function page(body: unknown) {
  return { json: async () => body };
}

beforeEach(() => {
  mockApiRequest.mockReset();
  mockOnline = true;
  mockAuth = { roles: ['CHIEF'], getAccessToken: jest.fn(), renewSilently: jest.fn() };
});

test('lists the last 72 hours and starts a report from a dispatch without typing its ID', async () => {
  mockApiRequest
    .mockResolvedValueOnce(
      page({
        recentWindowHours: 72,
        nextCursor: 'older-1',
        dispatches: [
          {
            dispatchId: 'd-1',
            incidentType: 'Structure fire',
            address: '18 Nichols Ave',
            dispatchedAt: now - 30 * 3600,
            report: null,
          },
          {
            dispatchId: 'd-2',
            incidentType: 'MVA',
            address: '5 Main St',
            dispatchedAt: now - 3600,
            report: { incidentId: 'd-2', status: 'DRAFT' },
          },
        ],
      }),
    )
    .mockResolvedValueOnce(page({ incidentId: 'd-1' }));

  await render(<ReportDispatchesScreen />);
  expect(await screen.findByText('18 Nichols Ave')).toBeTruthy();
  expect(mockApiRequest.mock.calls[0]?.[0]).toBe('incidents/dispatches');
  expect(screen.getByText(/Report started \(draft\)/)).toBeTruthy();

  await act(async () => {
    fireEvent.press(
      screen.getByRole('button', { name: 'Start report for Structure fire at 18 Nichols Ave' }),
    );
  });

  expect(mockApiRequest.mock.calls[1]?.[0]).toBe('incidents');
  expect(JSON.parse(mockApiRequest.mock.calls[1]?.[2].body as string)).toEqual({
    dispatchId: 'd-1',
  });
  expect(await screen.findByText(/Finish it on the web under Incidents/)).toBeTruthy();
});

test('older dispatches load with the cursor', async () => {
  mockApiRequest
    .mockResolvedValueOnce(page({ recentWindowHours: 72, nextCursor: 'c-1', dispatches: [] }))
    .mockResolvedValueOnce(
      page({
        recentWindowHours: 72,
        nextCursor: null,
        dispatches: [
          {
            dispatchId: 'd-9',
            incidentType: 'Brush fire',
            address: '9 Old Rd',
            dispatchedAt: now - 10 * 86400,
            report: null,
          },
        ],
      }),
    );

  await render(<ReportDispatchesScreen />);
  expect(await screen.findByText('No dispatches in the last 72 hours.')).toBeTruthy();
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Load older dispatches' }));
  });
  expect(await screen.findByText('9 Old Rd')).toBeTruthy();
  expect(mockApiRequest.mock.calls[1]?.[0]).toBe('incidents/dispatches?cursor=c-1');
});

test('an officer sees the list but not Start, and offline says plainly it needs a connection', async () => {
  mockAuth = { roles: ['OFFICER'], getAccessToken: jest.fn(), renewSilently: jest.fn() };
  mockOnline = false;

  await render(<ReportDispatchesScreen />);

  expect(await screen.findByText(/You're offline/)).toBeTruthy();
  expect(
    screen.getByText('The chief or an administrator starts a report from a dispatch.'),
  ).toBeTruthy();
  expect(mockApiRequest).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /Start report/ })).toBeNull();
});
