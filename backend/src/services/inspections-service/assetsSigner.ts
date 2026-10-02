import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';

// Pre-plan and inspection-photo files live in the platform-assets bucket and are read and
// written directly by the client through short-lived S3 presigned URLs. architecture.md §8
// describes CloudFront signed URLs, but N6.1 (U.S. residency, no global edge) forbids
// CloudFront repo-wide — infrastructure/test/residency-encryption.test.ts enforces it — so
// the URLs are regional S3 SigV4 presigned URLs instead, with the same 10-minute expiry and
// the same {deptId}/{entityType}/{entityId}/{filename} key scoping.
export interface AssetsConfig {
  readonly bucketName: string;
}

export function readAssetsConfig(env: NodeJS.ProcessEnv): AssetsConfig {
  const bucketName = env.PLATFORM_ASSETS_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('PLATFORM_ASSETS_BUCKET_NAME is required and was not set');
  }
  return { bucketName };
}

export interface AssetUrlRequest {
  readonly bucketName: string;
  readonly key: string;
  readonly method: 'GET' | 'PUT';
  readonly expiresInSeconds: number;
}

export type SignUrlFn = (request: AssetUrlRequest) => Promise<string>;

export const ASSET_URL_EXPIRY_SECONDS = 10 * 60;

let cachedS3Client: S3Client | undefined;

// Presigning is a local SigV4 computation with the Lambda role's credentials — no network
// call — so the client is not wrapped in X-Ray.
export const presignAssetUrl: SignUrlFn = async (request) => {
  cachedS3Client ??= new S3Client({});
  const input = { Bucket: request.bucketName, Key: request.key };
  if (request.method === 'PUT') {
    return getSignedUrl(
      cachedS3Client,
      new PutObjectCommand({ ...input, ContentType: requireUploadContentType(request.key) }),
      // The presigner signs only `host` unless told otherwise; without this S3 would accept
      // any Content-Type on the PUT.
      { expiresIn: request.expiresInSeconds, signableHeaders: new Set(SIGNED_UPLOAD_HEADERS) },
    );
  }
  return getSignedUrl(
    cachedS3Client,
    new GetObjectCommand({ ...input, ...safeResponseOverrides(request.key) }),
    { expiresIn: request.expiresInSeconds },
  );
};

/** Headers a presigned upload PUT is signed over: the client must send exactly these. */
export const SIGNED_UPLOAD_HEADERS: ReadonlySet<string> = new Set(['content-type']);

/**
 * What a platform-assets upload may be (review MINOR 4): documents and photos. A presigned
 * PUT does not constrain the body's Content-Type, so without this an upload could be .html
 * or .svg that a later presigned GET hands a browser as a page on the bucket origin
 * (phishing). Shared with training-service/attachmentUpload.ts.
 *
 * The PUT is signed with the allowlisted Content-Type (requireUploadContentType).
 *
 * Size is NOT limited: a presigned PUT can only fix an exact Content-Length the client
 * declares up front, and the web and mobile clients do not send one. A real cap needs a
 * presigned POST with a content-length-range condition, which changes both clients' upload
 * code (and the mobile outbox's replay) - left as a follow-up rather than done half-way.
 */
export const UPLOAD_CONTENT_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** The allowlisted content type for a filename or key, by extension; undefined otherwise. */
export function uploadContentTypeFor(filename: string): string | undefined {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return undefined;
  }
  const extension = filename.slice(lastDot + 1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(UPLOAD_CONTENT_TYPES, extension)
    ? UPLOAD_CONTENT_TYPES[extension]
    : undefined;
}

/**
 * The content type a presigned PUT is signed with (review minor 11). Signing it means S3
 * refuses the upload unless the client sends exactly this Content-Type, so a stored object
 * always carries the type its extension allows. The API returns it next to each upload URL
 * and the clients send it. Throws for a key outside the allowlist: every caller validates
 * the filename first, so reaching this is a bug, not a user error.
 */
export function requireUploadContentType(key: string): string {
  const contentType = uploadContentTypeFor(key);
  if (!contentType) {
    throw new TypeError(`no allowlisted upload content type for ${key}`);
  }
  return contentType;
}

/**
 * GET response overrides: S3 serves the object with the type its extension allows, whatever
 * Content-Type the uploader sent, so a stored object can never come back as text/html. An
 * object from before the allowlist (unknown extension) is served as a download.
 */
export function safeResponseOverrides(key: string): {
  ResponseContentType: string;
  ResponseContentDisposition?: string;
} {
  const contentType = uploadContentTypeFor(key);
  return contentType
    ? { ResponseContentType: contentType }
    : { ResponseContentType: 'application/octet-stream', ResponseContentDisposition: 'attachment' };
}

const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

/** Path-safe as a key segment (also used for ids that become key segments). */
export function isSafeAssetFilename(filename: string): boolean {
  return SAFE_FILENAME_PATTERN.test(filename) && filename !== '.' && filename !== '..';
}

/** A filename a client may be given an upload URL for: path-safe and an allowlisted type. */
export function isAllowedUploadFilename(filename: string): boolean {
  return isSafeAssetFilename(filename) && uploadContentTypeFor(filename) !== undefined;
}

export function buildAssetKey(
  deptId: VerifiedDeptId,
  entityType: string,
  entityId: string,
  filename: string,
): string {
  return `${deptId}/${entityType}/${entityId}/${filename}`;
}

/** A presigned GET for an already-stored object (download/read path). */
export function createSignedAssetUrl(
  config: AssetsConfig,
  key: string,
  signer: SignUrlFn = presignAssetUrl,
): Promise<string> {
  return signer({
    bucketName: config.bucketName,
    key,
    method: 'GET',
    expiresInSeconds: ASSET_URL_EXPIRY_SECONDS,
  });
}

/** A presigned PUT the client uploads the file body to (upload path). */
export function createSignedUploadUrl(
  config: AssetsConfig,
  key: string,
  signer: SignUrlFn = presignAssetUrl,
): Promise<string> {
  return signer({
    bucketName: config.bucketName,
    key,
    method: 'PUT',
    expiresInSeconds: ASSET_URL_EXPIRY_SECONDS,
  });
}
