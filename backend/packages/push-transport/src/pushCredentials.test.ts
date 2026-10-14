import { generateKeyPairSync } from 'node:crypto';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PushCredentialsUnavailableError,
  loadApnsCredentials,
  loadFcmCredentials,
  resetPushCredentialCaches,
} from './pushCredentials.js';

const P8 = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const RSA_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const APNS = { teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: P8, bundleId: 'org.b.app' };
const FCM = { project_id: 'p', client_email: 'e@p.iam', private_key: RSA_PEM };

function clientWith(secret: Record<string, unknown>): SecretsManagerClient {
  return {
    send: vi.fn().mockResolvedValue({ SecretString: JSON.stringify(secret) }),
  } as unknown as SecretsManagerClient;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('malformed push secrets are terminal configuration faults', () => {
  afterEach(() => resetPushCredentialCaches());

  it.each([
    ['APNs missing bundleId', { ...APNS, bundleId: undefined }],
    ['APNs bad environment', { ...APNS, environment: 'Production' }],
    ['APNs bad interruptionLevel', { ...APNS, interruptionLevel: 'loud' }],
    ['APNs bad PEM', { ...APNS, privateKey: 'not a pem' }],
    ['APNs RSA key instead of EC', { ...APNS, privateKey: RSA_PEM }],
  ])('%s', async (_name, secret) => {
    const error = await rejection(loadApnsCredentials('apns-secret', clientWith(secret)));
    expect(error).toBeInstanceOf(PushCredentialsUnavailableError);
    expect(error).toMatchObject({ transient: false, secretKey: 'apns-secret' });
    expect((error as Error).message).not.toContain('not a pem');
  });

  it('APNs sandbox secret declaring production', async () => {
    const error = await rejection(
      loadApnsCredentials('sb', clientWith({ ...APNS, environment: 'production' }), {
        sandbox: true,
      }),
    );
    expect(error).toMatchObject({ name: 'PushCredentialsUnavailableError', transient: false });
  });

  it.each([
    ['FCM missing project_id', { ...FCM, project_id: undefined }],
    ['FCM bad apnsInterruptionLevel', { ...FCM, apnsInterruptionLevel: 'loud' }],
    ['FCM bad PEM', { ...FCM, private_key: 'not a pem' }],
    ['FCM EC key instead of RSA', { ...FCM, private_key: P8 }],
  ])('%s', async (_name, secret) => {
    const error = await rejection(loadFcmCredentials('fcm-secret', clientWith(secret)));
    expect(error).toMatchObject({ name: 'PushCredentialsUnavailableError', transient: false });
  });

  it('drops the cached bad secret so a corrected one is read on the next page', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ SecretString: JSON.stringify({ ...APNS, bundleId: undefined }) })
      .mockResolvedValueOnce({ SecretString: JSON.stringify(APNS) });
    const client = { send } as unknown as SecretsManagerClient;
    await rejection(loadApnsCredentials('s', client));
    await expect(loadApnsCredentials('s', client)).resolves.toMatchObject({
      bundleId: 'org.b.app',
    });
  });
});
