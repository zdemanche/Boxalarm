import {
  currentRegistrationEpoch,
  getNativePushBridge,
  registerPushToken,
  RegistrationCancelledError,
  revokePushToken,
  stopRegistrations,
} from './pushTokens';

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
  // apnsEnvironment: the backend sends on this build's APNs host (Jest runs as a __DEV__ build).
  expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
    platform: 'APNS',
    token: 'device-token',
    deviceId: '0b6f1c2e-5d0a-4d9e-9b51-1c2f3a4b5c6d',
    apnsEnvironment: 'development',
  });
});

test('an FCM registration carries no APNs environment', async () => {
  const calls: { init: RequestInit }[] = [];
  globalThis.fetch = jest.fn(async (_url: string, init: RequestInit) => {
    calls.push({ init });
    return new Response(JSON.stringify({ registered: true }), { status: 200 });
  }) as unknown as typeof fetch;

  await registerPushToken('MBR-1', tokens, 'https://api.example.test', {
    platform: 'FCM',
    token: 'fcm-token',
  });

  expect(JSON.parse(calls[0]?.init.body as string)).not.toHaveProperty('apnsEnvironment');
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

// m3: a registration of the session being signed out must not land after its revoke.
test('sign-out waits for a registration already sent, then refuses the session’s later ones', async () => {
  const order: string[] = [];
  let answer: () => void = () => undefined;
  globalThis.fetch = jest.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((resolve) => {
        answer = () => {
          order.push(`${init.method} answered`);
          resolve(new Response('{}', { status: 200 }));
        };
      }),
  ) as unknown as typeof fetch;
  const epoch = currentRegistrationEpoch();
  const device = { platform: 'FCM' as const, token: 't' };

  const sent = registerPushToken('MBR-1', tokens, 'https://api.example.test', device, epoch);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stopping = stopRegistrations(5_000).then(() => order.push('stopped'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(order).toEqual([]);
  answer();
  await sent;
  await stopping;
  expect(order).toEqual(['POST answered', 'stopped']);

  (globalThis.fetch as jest.Mock).mockClear();
  await expect(
    registerPushToken('MBR-1', tokens, 'https://api.example.test', device, epoch),
  ).rejects.toBeInstanceOf(RegistrationCancelledError);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
