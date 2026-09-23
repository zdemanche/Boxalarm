import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import xray from 'aws-xray-sdk-core';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';

export interface DefectPhotoUploadConfig {
  readonly distributionDomain: string;
  readonly keyPairId: string;
  readonly privateKey: string;
}

let cachedSecretsClient: SecretsManagerClient | undefined;

export function createSecretsManagerClient(client?: SecretsManagerClient): SecretsManagerClient {
  cachedSecretsClient ??= client ?? xray.captureAWSv3Client(new SecretsManagerClient({}));
  return cachedSecretsClient;
}

export async function readDefectPhotoUploadConfig(
  env: NodeJS.ProcessEnv,
  secretsClient?: SecretsManagerClient,
): Promise<DefectPhotoUploadConfig> {
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

export interface CreateDefectPhotoUploadUrlParams {
  readonly deptId: VerifiedDeptId;
  readonly defectId: string;
  readonly filename: string;
}

export interface DefectPhotoUpload {
  readonly photoS3Key: string;
  readonly uploadUrl: string;
}

const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// The CloudFront signed URL this module issues has no way to constrain the Content-Type or
// size of what the client PUTs (CloudFront signed-URL policies only support date/IP
// conditions), so this extension allowlist is the only control available in this repo against
// a defect "photo" upload that is actually an .html/.svg/.js payload later served back from
// the trusted assets.boxalarm.dev origin (stored-content/XSS risk).
const ALLOWED_PHOTO_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg',
  'jpeg',
  'png',
  'heic',
  'heif',
  'webp',
]);

function isSafeFilename(filename: string): boolean {
  if (!SAFE_FILENAME.test(filename)) {
    return false;
  }
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return false;
  }
  return ALLOWED_PHOTO_EXTENSIONS.has(filename.slice(lastDot + 1).toLowerCase());
}

export function createDefectPhotoUploadUrl(
  config: DefectPhotoUploadConfig,
  params: CreateDefectPhotoUploadUrlParams,
): DefectPhotoUpload {
  if (!isSafeFilename(params.filename)) {
    throw new TypeError(
      `photo filename must match ${SAFE_FILENAME} with an allowed image extension ` +
        `(${[...ALLOWED_PHOTO_EXTENSIONS].join(', ')}): received ${JSON.stringify(params.filename)}`,
    );
  }
  const photoS3Key = `${params.deptId}/defect/${params.defectId}/${params.filename}`;
  const urlPath = `${params.deptId}/defect/${params.defectId}/${encodeURIComponent(params.filename)}`;
  const uploadUrl = getSignedUrl({
    url: `https://${config.distributionDomain}/${urlPath}`,
    keyPairId: config.keyPairId,
    privateKey: config.privateKey,
    dateLessThan: new Date(Date.now() + UPLOAD_URL_EXPIRY_MS).toISOString(),
  });
  return { photoS3Key, uploadUrl };
}
