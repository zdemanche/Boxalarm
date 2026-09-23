import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  buildAssetKey,
  createSignedAssetUrl,
  createSignedUploadUrl,
  isSafeAssetFilename,
} from './assetsSigner.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const CONFIG = {
  bucketName: 'nichols-boxalarm-platform-assets',
  cloudFrontDomain: 'assets.example.com',
  keyPairId: 'KEYPAIR123',
  privateKey: 'fake-private-key',
};

function fakeSecretsClient(secretString: string | undefined = 'fake-private-key'): {
  client: SecretsManagerClient;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue({ SecretString: secretString });
  return { client: { send } as unknown as SecretsManagerClient, send };
}

describe('readAssetsConfig', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it.each([
    ['PLATFORM_ASSETS_BUCKET_NAME'],
    ['PLATFORM_ASSETS_CLOUDFRONT_DOMAIN'],
    ['PLATFORM_ASSETS_CLOUDFRONT_KEY_PAIR_ID'],
    ['PLATFORM_ASSETS_CLOUDFRONT_PRIVATE_KEY_SECRET_ID'],
  ])('throws when %s is not set', async (missingKey) => {
    const { readAssetsConfig } = await import('./assetsSigner.js');
    const env: NodeJS.ProcessEnv = {
      PLATFORM_ASSETS_BUCKET_NAME: 'bucket',
      PLATFORM_ASSETS_CLOUDFRONT_DOMAIN: 'domain',
      PLATFORM_ASSETS_CLOUDFRONT_KEY_PAIR_ID: 'kp',
      PLATFORM_ASSETS_CLOUDFRONT_PRIVATE_KEY_SECRET_ID: 'secret-id',
      [missingKey]: undefined,
    };
    await expect(readAssetsConfig(env, fakeSecretsClient().client)).rejects.toThrow(
      `${missingKey} is required and was not set`,
    );
  });

  it('resolves the private key from Secrets Manager, not from a raw env literal', async () => {
    const { readAssetsConfig } = await import('./assetsSigner.js');
    const env: NodeJS.ProcessEnv = {
      PLATFORM_ASSETS_BUCKET_NAME: 'bucket',
      PLATFORM_ASSETS_CLOUDFRONT_DOMAIN: 'domain',
      PLATFORM_ASSETS_CLOUDFRONT_KEY_PAIR_ID: 'kp',
      PLATFORM_ASSETS_CLOUDFRONT_PRIVATE_KEY_SECRET_ID: 'secret-id',
    };
    const { client, send } = fakeSecretsClient('secret-value');
    const config = await readAssetsConfig(env, client);
    expect(config.privateKey).toBe('secret-value');
    const command = send.mock.calls[0]?.[0] as { input: { SecretId: string } };
    expect(command.input.SecretId).toBe('secret-id');
  });

  it('throws when the secret has no SecretString value', async () => {
    const { readAssetsConfig } = await import('./assetsSigner.js');
    const env: NodeJS.ProcessEnv = {
      PLATFORM_ASSETS_BUCKET_NAME: 'bucket',
      PLATFORM_ASSETS_CLOUDFRONT_DOMAIN: 'domain',
      PLATFORM_ASSETS_CLOUDFRONT_KEY_PAIR_ID: 'kp',
      PLATFORM_ASSETS_CLOUDFRONT_PRIVATE_KEY_SECRET_ID: 'secret-id',
    };
    const client = {
      send: vi.fn().mockResolvedValue({ SecretString: undefined }),
    } as unknown as SecretsManagerClient;
    await expect(readAssetsConfig(env, client)).rejects.toThrow(
      'Secret secret-id has no SecretString value',
    );
  });
});

describe('isSafeAssetFilename', () => {
  it('accepts plain filenames', () => {
    expect(isSafeAssetFilename('diagram.pdf')).toBe(true);
    expect(isSafeAssetFilename('photo_1-final.JPG')).toBe(true);
  });

  it.each(['../../OTHERDEPT/diagram.pdf', 'a/b.pdf', '..', '.', '', 'a'.repeat(201)])(
    'rejects unsafe filename %s',
    (filename) => {
      expect(isSafeAssetFilename(filename)).toBe(false);
    },
  );
});

describe('buildAssetKey', () => {
  it('builds the {deptId}/{entityType}/{entityId}/{filename} key per AC2/AC3', () => {
    expect(buildAssetKey(DEPT_ID, 'PRE_PLAN', 'PP-0044', 'diagram.pdf')).toBe(
      'NICHOLS/PRE_PLAN/PP-0044/diagram.pdf',
    );
    expect(buildAssetKey(DEPT_ID, 'INSPECTION_RECORD', 'INS-1', 'photo.jpg')).toBe(
      'NICHOLS/INSPECTION_RECORD/INS-1/photo.jpg',
    );
  });
});

describe('createSignedUploadUrl', () => {
  it('signs the CloudFront URL for the exact prefixed key with a 10-minute expiry', () => {
    const signer = vi.fn().mockReturnValue('https://signed.example.com/x');
    const url = createSignedUploadUrl(
      CONFIG,
      DEPT_ID,
      'PRE_PLAN',
      'PP-0044',
      'diagram.pdf',
      signer,
    );

    expect(url).toBe('https://signed.example.com/x');
    expect(signer).toHaveBeenCalledTimes(1);
    const call = signer.mock.calls[0]?.[0] as {
      url: string;
      keyPairId: string;
      privateKey: string;
      dateLessThan: string;
    };
    expect(call.url).toBe('https://assets.example.com/NICHOLS/PRE_PLAN/PP-0044/diagram.pdf');
    expect(call.keyPairId).toBe('KEYPAIR123');
    expect(call.privateKey).toBe('fake-private-key');
    const expiryMs = new Date(call.dateLessThan).getTime() - Date.now();
    expect(expiryMs).toBeGreaterThan(9 * 60 * 1000);
    expect(expiryMs).toBeLessThanOrEqual(10 * 60 * 1000);
  });
});

describe('createSignedAssetUrl', () => {
  it('signs a URL for an already-stored S3 key (GET/read path)', () => {
    const signer = vi.fn().mockReturnValue('https://signed.example.com/read');
    const url = createSignedAssetUrl(CONFIG, 'NICHOLS/PRE_PLAN/PP-1/diagram.pdf', signer);
    expect(url).toBe('https://signed.example.com/read');
    const call = signer.mock.calls[0]?.[0] as { url: string };
    expect(call.url).toBe('https://assets.example.com/NICHOLS/PRE_PLAN/PP-1/diagram.pdf');
  });
});
