import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import xray from 'aws-xray-sdk-core';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';

export interface AttachmentUploadConfig {
  readonly distributionDomain: string;
  readonly keyPairId: string;
  readonly privateKey: string;
}

let cachedSecretsClient: SecretsManagerClient | undefined;

export function createSecretsManagerClient(client?: SecretsManagerClient): SecretsManagerClient {
  cachedSecretsClient ??= client ?? xray.captureAWSv3Client(new SecretsManagerClient({}));
  return cachedSecretsClient;
}

export async function readAttachmentUploadConfig(
  env: NodeJS.ProcessEnv,
  secretsClient?: SecretsManagerClient,
): Promise<AttachmentUploadConfig> {
  const distributionDomain = env.CLOUDFRONT_DISTRIBUTION_DOMAIN;
  const keyPairId = env.CLOUDFRONT_KEY_PAIR_ID;
  const privateKeySecretId = env.CLOUDFRONT_PRIVATE_KEY_SECRET_ID;
  if (!distributionDomain) {
    throw new Error('CLOUDFRONT_DISTRIBUTION_DOMAIN is required and was not set');
  }
  if (!keyPairId) {
    throw new Error('CLOUDFRONT_KEY_PAIR_ID is required and was not set');
  }
  if (!privateKeySecretId) {
    throw new Error('CLOUDFRONT_PRIVATE_KEY_SECRET_ID is required and was not set');
  }
  const client = createSecretsManagerClient(secretsClient);
  const output = await client.send(new GetSecretValueCommand({ SecretId: privateKeySecretId }));
  const privateKey = output.SecretString;
  if (!privateKey) {
    throw new Error(`Secret ${privateKeySecretId} has no SecretString value`);
  }
  return { distributionDomain, keyPairId, privateKey };
}

const UPLOAD_URL_EXPIRY_MS = 10 * 60 * 1000;

export interface CreateAttachmentUploadUrlParams {
  readonly deptId: VerifiedDeptId;
  readonly certId: string;
  readonly filename: string;
}

export interface AttachmentUpload {
  readonly attachmentS3Key: string;
  readonly uploadUrl: string;
}

const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSafeFilename(filename: string): boolean {
  return SAFE_FILENAME.test(filename);
}

export function createAttachmentUploadUrl(
  config: AttachmentUploadConfig,
  params: CreateAttachmentUploadUrlParams,
): AttachmentUpload {
  if (!isSafeFilename(params.filename)) {
    throw new TypeError(
      `attachment filename must match ${SAFE_FILENAME}: received ${JSON.stringify(params.filename)}`,
    );
  }
  const attachmentS3Key = `${params.deptId}/CERTIFICATION/${params.certId}/${params.filename}`;
  const urlPath = `${params.deptId}/CERTIFICATION/${params.certId}/${encodeURIComponent(params.filename)}`;
  const uploadUrl = getSignedUrl({
    url: `https://${config.distributionDomain}/${urlPath}`,
    keyPairId: config.keyPairId,
    privateKey: config.privateKey,
    dateLessThan: new Date(Date.now() + UPLOAD_URL_EXPIRY_MS).toISOString(),
  });
  return { attachmentS3Key, uploadUrl };
}
