import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createAttachmentUploadUrl } from './attachmentUpload.js';

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

describe('readAttachmentUploadConfig', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it.each([
    ['CLOUDFRONT_DISTRIBUTION_DOMAIN'],
    ['CLOUDFRONT_KEY_PAIR_ID'],
    ['CLOUDFRONT_PRIVATE_KEY_SECRET_ID'],
  ])('throws when %s is not set', async (missingKey) => {
    const { readAttachmentUploadConfig } = await import('./attachmentUpload.js');
    const env: NodeJS.ProcessEnv = {
      CLOUDFRONT_DISTRIBUTION_DOMAIN: 'assets.boxalarm.dev',
      CLOUDFRONT_KEY_PAIR_ID: 'KEYPAIR123',
      CLOUDFRONT_PRIVATE_KEY_SECRET_ID: 'cf-signing-key',
      [missingKey]: undefined,
    };
    await expect(
      readAttachmentUploadConfig(env, fakeSecretsClient(testPrivateKeyPem).client),
    ).rejects.toThrow(`${missingKey} is required and was not set`);
  });

  it('resolves the private key from Secrets Manager, not from a raw env literal', async () => {
    const { readAttachmentUploadConfig } = await import('./attachmentUpload.js');
    const env: NodeJS.ProcessEnv = {
      CLOUDFRONT_DISTRIBUTION_DOMAIN: 'assets.boxalarm.dev',
      CLOUDFRONT_KEY_PAIR_ID: 'KEYPAIR123',
      CLOUDFRONT_PRIVATE_KEY_SECRET_ID: 'cf-signing-key',
    };
    const { client, send } = fakeSecretsClient(testPrivateKeyPem);
    const config = await readAttachmentUploadConfig(env, client);

    expect(send).toHaveBeenCalledTimes(1);
    expect(config).toEqual({
      distributionDomain: 'assets.boxalarm.dev',
      keyPairId: 'KEYPAIR123',
      privateKey: testPrivateKeyPem,
    });
  });

  it('throws when the secret has no SecretString value', async () => {
    const { readAttachmentUploadConfig } = await import('./attachmentUpload.js');
    const env: NodeJS.ProcessEnv = {
      CLOUDFRONT_DISTRIBUTION_DOMAIN: 'assets.boxalarm.dev',
      CLOUDFRONT_KEY_PAIR_ID: 'KEYPAIR123',
      CLOUDFRONT_PRIVATE_KEY_SECRET_ID: 'cf-signing-key',
    };
    await expect(
      readAttachmentUploadConfig(env, fakeSecretsClient(undefined).client),
    ).rejects.toThrow('Secret cf-signing-key has no SecretString value');
  });
});

describe('createAttachmentUploadUrl', () => {
  const config = {
    distributionDomain: 'assets.boxalarm.dev',
    keyPairId: 'KEYPAIR123',
    privateKey: testPrivateKeyPem,
  };

  it('scopes the attachment key and signed URL to {deptId}/CERTIFICATION/{certId}/ (AC2)', () => {
    const result = createAttachmentUploadUrl(config, {
      deptId,
      certId: 'CERT-0091',
      filename: 'card.pdf',
    });

    expect(result.attachmentS3Key).toBe('NICHOLS/CERTIFICATION/CERT-0091/card.pdf');
    expect(
      result.uploadUrl.startsWith(
        'https://assets.boxalarm.dev/NICHOLS/CERTIFICATION/CERT-0091/card.pdf',
      ),
    ).toBe(true);
    expect(result.uploadUrl).toContain('Key-Pair-Id=KEYPAIR123');
  });

  it('rejects a filename attempting a prefix-escape via a path separator', () => {
    expect(() =>
      createAttachmentUploadUrl(config, { deptId, certId: 'CERT-0091', filename: 'sub/card.pdf' }),
    ).toThrow(TypeError);
  });

  it('rejects a filename attempting a prefix-escape via ..', () => {
    expect(() =>
      createAttachmentUploadUrl(config, { deptId, certId: 'CERT-0091', filename: '../card.pdf' }),
    ).toThrow(TypeError);
  });

  it('rejects a filename containing a query-string separator', () => {
    expect(() =>
      createAttachmentUploadUrl(config, { deptId, certId: 'CERT-0091', filename: 'a?b.pdf' }),
    ).toThrow(TypeError);
  });

  it('rejects a filename containing a fragment separator', () => {
    expect(() =>
      createAttachmentUploadUrl(config, { deptId, certId: 'CERT-0091', filename: 'a#b.pdf' }),
    ).toThrow(TypeError);
  });

  it('rejects a percent-encoded dot-segment escape attempt', () => {
    expect(() =>
      createAttachmentUploadUrl(config, {
        deptId,
        certId: 'CERT-0091',
        filename: '%2e%2e%2fevil.pdf',
      }),
    ).toThrow(TypeError);
  });

  it('percent-encodes the filename segment in the signed URL', () => {
    const result = createAttachmentUploadUrl(config, {
      deptId,
      certId: 'CERT-0091',
      filename: 'card-v2.pdf',
    });

    expect(result.attachmentS3Key).toBe('NICHOLS/CERTIFICATION/CERT-0091/card-v2.pdf');
    expect(
      result.uploadUrl.startsWith(`https://assets.boxalarm.dev/${result.attachmentS3Key}`),
    ).toBe(true);
  });
});
