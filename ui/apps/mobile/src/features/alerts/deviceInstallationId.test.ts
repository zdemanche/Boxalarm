import * as Keychain from 'react-native-keychain';
import { getDeviceInstallationId, resetDeviceInstallationIdCache } from './deviceInstallationId';

jest.mock('react-native-keychain', () => ({
  getGenericPassword: jest.fn(),
  setGenericPassword: jest.fn(async () => ({ service: 'x', storage: 'keychain' })),
}));

const getGenericPassword = Keychain.getGenericPassword as jest.Mock;
const setGenericPassword = Keychain.setGenericPassword as jest.Mock;

beforeEach(() => {
  resetDeviceInstallationIdCache();
  getGenericPassword.mockReset();
  setGenericPassword.mockClear();
});

test('reuses the installation id kept in the keychain', async () => {
  getGenericPassword.mockResolvedValue({ username: 'installation-id', password: 'stored-id' });
  await expect(getDeviceInstallationId()).resolves.toBe('stored-id');
  expect(setGenericPassword).not.toHaveBeenCalled();
});

test('creates, stores and then reuses a UUID when none is kept', async () => {
  getGenericPassword.mockResolvedValue(false);
  const id = await getDeviceInstallationId();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(setGenericPassword).toHaveBeenCalledWith('installation-id', id, {
    service: 'boxalarm-device-installation',
  });
  await expect(getDeviceInstallationId()).resolves.toBe(id);
});

test('still returns an id when the keychain is unavailable', async () => {
  getGenericPassword.mockRejectedValue(new Error('no keychain'));
  setGenericPassword.mockRejectedValue(new Error('no keychain'));
  await expect(getDeviceInstallationId()).resolves.toMatch(/^[0-9a-f-]{36}$/);
});
