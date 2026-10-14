import { render } from '@testing-library/react-native';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { apiRequest } from '../../lib/apiClient';
import { RosterScreen } from './RosterScreen';

jest.mock('../../lib/apiClient', () => ({
  ...jest.requireActual('../../lib/apiClient'),
  apiRequest: jest.fn(),
}));
jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));
jest.mock('react-native-config', () => ({
  __esModule: true,
  default: { API_BASE_URL: 'https://api.example.com' },
}));
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: { dispatchId: 'D-1' } }),
  useIsFocused: () => true,
}));
jest.mock('../../sync/ConnectivityContext', () => ({
  useConnectivity: () => ({ isOnline: true }),
}));

test('a member nobody has heard from yet (server ackStatus NONE) reads Awaiting response', async () => {
  (useOptionalAuth as jest.Mock).mockReturnValue({
    isAuthenticated: true,
    memberId: 'MBR-1',
    getAccessToken: jest.fn(),
    renewSilently: jest.fn(),
  });
  (apiRequest as jest.Mock).mockResolvedValue({
    json: async () => ({
      members: [
        {
          memberId: 'MBR-1',
          name: 'Jamie Rios',
          ackStatus: 'NONE',
          eta: null,
          assignedApparatusId: null,
          quals: [],
          lastAnsweredTone: null,
        },
      ],
    }),
  });
  expect((Config as unknown as { API_BASE_URL: string }).API_BASE_URL).toBeTruthy();

  const { findByText } = await render(<RosterScreen />);

  expect(await findByText('Jamie Rios')).toBeTruthy();
  expect(await findByText('Awaiting response')).toBeTruthy();
});
