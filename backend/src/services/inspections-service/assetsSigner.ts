import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import xray from 'aws-xray-sdk-core';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';

export interface AssetsConfig {
  readonly bucketName: string;
  readonly cloudFrontDomain: string;
  readonly keyPairId: string;
  readonly privateKey: string;
}

let cachedSecretsClient: SecretsManagerClient | undefined;

export function createSecretsManagerClient(client?: SecretsManagerClient): SecretsManagerClient {
  cachedSecretsClient ??= client ?? xray.captureAWSv3Client(new SecretsManagerClient({}));
  return cachedSecretsClient;
}

export async function readAssetsConfig(
  env: NodeJS.ProcessEnv,
  secretsClient?: SecretsManagerClient,
): Promise<AssetsConfig> {
  const bucketName = env.PLATFORM_ASSETS_BUCKET_NAME;
  const cloudFrontDomain = env.PLATFORM_ASSETS_CLOUDFRONT_DOMAIN;
  const keyPairId = env.PLATFORM_ASSETS_CLOUDFRONT_KEY_PAIR_ID;
  const privateKeySecretId = env.PLATFORM_ASSETS_CLOUDFRONT_PRIVATE_KEY_SECRET_ID;
  if (!bucketName) {
    throw new Error('PLATFORM_ASSETS_BUCKET_NAME is required and was not set');
  }
  if (!cloudFrontDomain) {
    throw new Error('PLATFORM_ASSETS_CLOUDFRONT_DOMAIN is required and was not set');
  }
  if (!keyPairId) {
    throw new Error('PLATFORM_ASSETS_CLOUDFRONT_KEY_PAIR_ID is required and was not set');
  }
  if (!privateKeySecretId) {
    throw new Error('PLATFORM_ASSETS_CLOUDFRONT_PRIVATE_KEY_SECRET_ID is required and was not set');
  }
  const client = createSecretsManagerClient(secretsClient);
  const output = await client.send(new GetSecretValueCommand({ SecretId: privateKeySecretId }));
  const privateKey = output.SecretString;
  if (!privateKey) {
    throw new Error(`Secret ${privateKeySecretId} has no SecretString value`);
  }
  return { bucketName, cloudFrontDomain, keyPairId, privateKey };
}

export type SignUrlFn = typeof getSignedUrl;

const ASSET_URL_EXPIRY_MS = 10 * 60 * 1000;

const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

export function isSafeAssetFilename(filename: string): boolean {
  return SAFE_FILENAME_PATTERN.test(filename) && filename !== '.' && filename !== '..';
}

export function buildAssetKey(deptId: VerifiedDeptId, prePlanId: string, filename: string): string {
  return `${deptId}/PRE_PLAN/${prePlanId}/${filename}`;
}

export function createSignedAssetUrl(
  config: AssetsConfig,
  key: string,
  signer: SignUrlFn = getSignedUrl,
): string {
  const dateLessThan = new Date(Date.now() + ASSET_URL_EXPIRY_MS).toISOString();
  return signer({
    url: `https://${config.cloudFrontDomain}/${key}`,
    keyPairId: config.keyPairId,
    privateKey: config.privateKey,
    dateLessThan,
  });
}

export function createSignedUploadUrl(
  config: AssetsConfig,
  deptId: VerifiedDeptId,
  prePlanId: string,
  filename: string,
  signer: SignUrlFn = getSignedUrl,
): string {
  return createSignedAssetUrl(config, buildAssetKey(deptId, prePlanId, filename), signer);
}
