import { getNativePushBridge, registerPushToken, revokePushToken } from './pushTokens';

jest.mock('./deviceInstallationId', () => ({
  getDeviceInstallationId: jest.fn(async () => '0b6f1c2e-5d0a-4d9e-9b51-1c2f3a4b5c6d'),
}));

const tokens = { getAccessToken: async () => 'access', renewSilently: async () => null };

test('registerPushToken POSTs the device token to the member push-tokens route', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ registered: true }), { status: 200 });
  }) as unknown as typeof fetch;

  await registerPushToken('MBR-1', tokens, 'https://api.example.test', {
    platform: 'APNS',
    token: 'device-token',
  });

  expect(calls[0]?.url).toBe('https://api.example.test/api/v1/personnel/members/MBR-1/push-tokens');
  expect(calls[0]?.init.method).toBe('POST');
  // deviceId: one PUSH entry per installation, so this device never replaces another.
  expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
    platform: 'APNS',
    token: 'device-token',
    deviceId: '0b6f1c2e-5d0a-4d9e-9b51-1c2f3a4b5c6d',
  });
});

test("revokePushToken DELETEs only this installation's entry", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ revoked: true }), { status: 200 });
  }) as unknown as typeof fetch;

  await revokePushToken('MBR-1', tokens, 'https://api.example.test');

  expect(calls[0]?.init.method).toBe('DELETE');
  expect(calls[0]?.url).toBe(
    'https://api.example.test/api/v1/personnel/members/MBR-1/push-tokens?deviceId=0b6f1c2e-5d0a-4d9e-9b51-1c2f3a4b5c6d',
  );
});

test('getNativePushBridge returns the real Firebase/notifee-backed bridge', () => {
  const bridge = getNativePushBridge();
  expect(typeof bridge.requestPermission).toBe('function');
  expect(typeof bridge.getToken).toBe('function');
  expect(typeof bridge.onTokenRefresh).toBe('function');
});
