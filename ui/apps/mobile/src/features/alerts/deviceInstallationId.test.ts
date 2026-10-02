import * as Keychain from 'react-native-keychain';
import { getDeviceInstallationId, resetDeviceInstallationIdCache } from './deviceInstallationId';

jest.mock('react-native-keychain', () => ({
  getGenericPassword: jest.fn(),
  setGenericPassword: jest.fn(async () => ({ service: 'x', storage: 'keychain' })),
  resetGenericPassword: jest.fn(async () => true),
  ACCESSIBLE: { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AccessibleAfterFirstUnlockThisDeviceOnly' },
}));

const getGenericPassword = Keychain.getGenericPassword as jest.Mock;
const setGenericPassword = Keychain.setGenericPassword as jest.Mock;

beforeEach(() => {
  resetDeviceInstallationIdCache();
  getGenericPassword.mockReset();
  setGenericPassword.mockReset().mockResolvedValue({ service: 'x', storage: 'keychain' });
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
    service: 'boxalarm-device-installation-v2',
    accessible: 'AccessibleAfterFirstUnlockThisDeviceOnly',
  });
  await expect(getDeviceInstallationId()).resolves.toBe(id);
});

test('still returns an id when the keychain is unavailable', async () => {
  getGenericPassword.mockRejectedValue(new Error('no keychain'));
  setGenericPassword.mockRejectedValue(new Error('no keychain'));
  await expect(getDeviceInstallationId()).resolves.toMatch(/^[0-9a-f-]{36}$/);
});

// N-M1: a backup restore or Quick Start must not copy the id to another phone.
test('an id kept before it was device-only is moved once to device-only storage, keeping it', async () => {
  getGenericPassword.mockImplementation(async ({ service }: { service: string }) =>
    service === 'boxalarm-device-installation'
      ? { username: 'installation-id', password: 'legacy-id' }
      : false,
  );

  await expect(getDeviceInstallationId()).resolves.toBe('legacy-id');
  expect(setGenericPassword).toHaveBeenCalledWith('installation-id', 'legacy-id', {
    service: 'boxalarm-device-installation-v2',
    accessible: 'AccessibleAfterFirstUnlockThisDeviceOnly',
  });
  expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({
    service: 'boxalarm-device-installation',
  });
});
