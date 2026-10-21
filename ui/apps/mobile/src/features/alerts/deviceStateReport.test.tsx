import { act, renderHook } from '@testing-library/react-native';
import { AppState, Platform } from 'react-native';
import { useOptionalAuth } from '../../auth/AuthContext';
import { apiRequest } from '../../lib/apiClient';
import { deviceStatePayload, useDeviceStateReport } from './deviceStateReport';
import { evaluateAlertReadiness, type ReadinessItem } from './useAlertReadiness';

jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));
jest.mock('../../lib/apiClient', () => ({ apiRequest: jest.fn() }));
jest.mock('./useAlertReadiness', () => ({ evaluateAlertReadiness: jest.fn() }));
jest.mock('react-native-config', () => ({
  __esModule: true,
  default: { API_BASE_URL: 'https://api.example.test' },
}));

const item = (id: ReadinessItem['id'], status: ReadinessItem['status']): ReadinessItem => ({
  id,
  status,
  label: id,
  detail: '',
  wakes: true,
});

const REQUIRED_KEYS = [
  'appVersion',
  'batteryOptimizationExempt',
  'criticalAlertPermission',
  'notificationPermission',
  'osVersion',
];

afterEach(() => jest.clearAllMocks());

test('payload carries exactly the keys reportStateHandler requires and fails closed on unknown', () => {
  Platform.OS = 'android';
  const payload = deviceStatePayload([
    item('notifications', 'ok'),
    item('dnd', 'unknown'),
    item('battery', 'warn'),
  ]);

  expect(Object.keys(payload).sort()).toEqual(REQUIRED_KEYS);
  expect(payload).toMatchObject({
    notificationPermission: true,
    criticalAlertPermission: false,
    batteryOptimizationExempt: false,
  });
  expect(typeof payload.appVersion).toBe('string');
  expect(payload.osVersion.length).toBeGreaterThan(0);
});

test('posts the device state on sign-in and swallows a failure', async () => {
  Platform.OS = 'ios';
  (useOptionalAuth as jest.Mock).mockReturnValue({ isAuthenticated: true, memberId: 'MBR-1' });
  (evaluateAlertReadiness as jest.Mock).mockResolvedValue([
    item('notifications', 'ok'),
    item('criticalAlerts', 'ok'),
  ]);
  (apiRequest as jest.Mock).mockRejectedValue(new Error('offline'));
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() } as never);

  renderHook(() => useDeviceStateReport());
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });

  const [path, , options] = (apiRequest as jest.Mock).mock.calls[0]!;
  expect(path).toBe('alerting/devices/state');
  expect(options.method).toBe('POST');
  expect(Object.keys(JSON.parse(options.body)).sort()).toEqual(REQUIRED_KEYS);
});
