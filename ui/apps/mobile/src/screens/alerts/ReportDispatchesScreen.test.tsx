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

test('an officer can start a report (Cedar CreateIncidentReport, officer tier)', async () => {
  mockAuth = { roles: ['OFFICER'], getAccessToken: jest.fn(), renewSilently: jest.fn() };
  mockApiRequest
    .mockResolvedValueOnce(
      page({
        recentWindowHours: 72,
        nextCursor: null,
        dispatches: [
          {
            dispatchId: 'd-3',
            incidentType: 'Alarm activation',
            address: '7 Elm St',
            dispatchedAt: now - 600,
            report: null,
          },
        ],
      }),
    )
    .mockResolvedValueOnce(page({ incidentId: 'd-3' }));

  await render(<ReportDispatchesScreen />);
  await act(async () => {
    fireEvent.press(
      await screen.findByRole('button', { name: 'Start report for Alarm activation at 7 Elm St' }),
    );
  });
  expect(JSON.parse(mockApiRequest.mock.calls[1]?.[2].body as string)).toEqual({
    dispatchId: 'd-3',
  });
});

test('a member gets no Start button', async () => {
  mockAuth = { roles: ['MEMBER'], getAccessToken: jest.fn(), renewSilently: jest.fn() };
  mockApiRequest.mockResolvedValueOnce(
    page({
      recentWindowHours: 72,
      nextCursor: null,
      dispatches: [
        {
          dispatchId: 'd-4',
          incidentType: 'MVA',
          address: '1 Oak',
          dispatchedAt: now - 60,
          report: null,
        },
      ],
    }),
  );
  await render(<ReportDispatchesScreen />);
  expect(await screen.findByText('No report yet')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Start report/ })).toBeNull();
});

test('offline says plainly it needs a connection and sends nothing', async () => {
  mockOnline = false;

  await render(<ReportDispatchesScreen />);

  expect(await screen.findByText(/You're offline/)).toBeTruthy();
  expect(mockApiRequest).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /Start report/ })).toBeNull();
});

test('an unparsed CAD dispatch shows VERIFY and its text instead of the placeholder address', async () => {
  mockApiRequest.mockResolvedValueOnce(
    page({
      recentWindowHours: 72,
      nextCursor: null,
      dispatches: [
        {
          dispatchId: 'd-raw',
          incidentType: 'STRUCTURE FIRE',
          address: 'SEE DISPATCH TEXT',
          dispatchedAt: now - 60,
          report: null,
          verifyRequired: true,
          textExcerpt: 'STRUC FIRE 12 ELM ST X OAK',
        },
      ],
    }),
  );
  await render(<ReportDispatchesScreen />);
  expect(await screen.findByText('VERIFY — location not parsed')).toBeTruthy();
  expect(screen.getByText('“STRUC FIRE 12 ELM ST X OAK”')).toBeTruthy();
  expect(screen.queryByText('SEE DISPATCH TEXT')).toBeNull();
});
