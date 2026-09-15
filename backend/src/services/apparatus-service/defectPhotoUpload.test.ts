import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDefectPhotoUploadUrl } from './defectPhotoUpload.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const testPrivateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function fakeSecretsClient(secretString: string | undefined): {
  client: SecretsManagerClient;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue({ SecretString: secretString });
  return { client: { send } as unknown as SecretsManagerClient, send };
}

describe('readDefectPhotoUploadConfig', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it.each([
    ['CLOUDFRONT_DISTRIBUTION_DOMAIN'],
    ['CLOUDFRONT_KEY_PAIR_ID'],
    ['CLOUDFRONT_PRIVATE_KEY_SECRET_ID'],
  ])('throws when %s is not set', async (missingKey) => {
    const { readDefectPhotoUploadConfig } = await import('./defectPhotoUpload.js');
    const env: NodeJS.ProcessEnv = {
      CLOUDFRONT_DISTRIBUTION_DOMAIN: 'assets.boxalarm.dev',
      CLOUDFRONT_KEY_PAIR_ID: 'KEYPAIR123',
      CLOUDFRONT_PRIVATE_KEY_SECRET_ID: 'cf-signing-key',
      [missingKey]: undefined,
    };
    await expect(
      readDefectPhotoUploadConfig(env, fakeSecretsClient(testPrivateKeyPem).client),
    ).rejects.toThrow(`${missingKey} is required and was not set`);
  });

  it('resolves the private key from Secrets Manager, not from a raw env literal', async () => {
    const { readDefectPhotoUploadConfig } = await import('./defectPhotoUpload.js');
    const env: NodeJS.ProcessEnv = {
      CLOUDFRONT_DISTRIBUTION_DOMAIN: 'assets.boxalarm.dev',
      CLOUDFRONT_KEY_PAIR_ID: 'KEYPAIR123',
      CLOUDFRONT_PRIVATE_KEY_SECRET_ID: 'cf-signing-key',
    };
    const { client, send } = fakeSecretsClient(testPrivateKeyPem);
    const config = await readDefectPhotoUploadConfig(env, client);

    expect(send).toHaveBeenCalledTimes(1);
    expect(config).toEqual({
      distributionDomain: 'assets.boxalarm.dev',
      keyPairId: 'KEYPAIR123',
      privateKey: testPrivateKeyPem,
    });
  });
});

describe('createDefectPhotoUploadUrl', () => {
  const config = {
    distributionDomain: 'assets.boxalarm.dev',
    keyPairId: 'KEYPAIR123',
    privateKey: testPrivateKeyPem,
  };

  it('scopes the photo key and signed URL to {deptId}/defect/{defectId}/', () => {
    const result = createDefectPhotoUploadUrl(config, {
      deptId,
      defectId: 'DEF-0033',
      filename: 'photo.jpg',
    });

    expect(result.photoS3Key).toBe('NICHOLS/defect/DEF-0033/photo.jpg');
    expect(
      result.uploadUrl.startsWith('https://assets.boxalarm.dev/NICHOLS/defect/DEF-0033/photo.jpg'),
    ).toBe(true);
    expect(result.uploadUrl).toContain('Key-Pair-Id=KEYPAIR123');
  });

  it('rejects a filename attempting a prefix-escape via a path separator', () => {
    expect(() =>
      createDefectPhotoUploadUrl(config, {
        deptId,
        defectId: 'DEF-0033',
        filename: 'sub/photo.jpg',
      }),
    ).toThrow(TypeError);
  });

  it('rejects a filename attempting a prefix-escape via ..', () => {
    expect(() =>
      createDefectPhotoUploadUrl(config, {
        deptId,
        defectId: 'DEF-0033',
        filename: '../photo.jpg',
      }),
    ).toThrow(TypeError);
  });
});
