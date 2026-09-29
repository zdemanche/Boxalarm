import { afterEach, describe, expect, it, vi } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  buildAssetKey,
  createSignedAssetUrl,
  createSignedUploadUrl,
  isAllowedUploadFilename,
  isSafeAssetFilename,
  presignAssetUrl,
  readAssetsConfig,
  safeResponseOverrides,
  uploadContentTypeFor,
} from './assetsSigner.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const CONFIG = { bucketName: 'boxalarm-dev-platform-assets' };

describe('readAssetsConfig', () => {
  it('reads the bucket name', () => {
    expect(readAssetsConfig({ PLATFORM_ASSETS_BUCKET_NAME: 'bucket' })).toEqual({
      bucketName: 'bucket',
    });
  });

  it('throws when PLATFORM_ASSETS_BUCKET_NAME is not set', () => {
    expect(() => readAssetsConfig({})).toThrow(
      'PLATFORM_ASSETS_BUCKET_NAME is required and was not set',
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
  it('presigns a PUT for the exact key with a 10-minute expiry', async () => {
    const signer = vi.fn().mockResolvedValue('https://signed.example.com/x');
    const url = await createSignedUploadUrl(CONFIG, 'NICHOLS/PRE_PLAN/PP-0044/diagram.pdf', signer);

    expect(url).toBe('https://signed.example.com/x');
    expect(signer).toHaveBeenCalledWith({
      bucketName: 'boxalarm-dev-platform-assets',
      key: 'NICHOLS/PRE_PLAN/PP-0044/diagram.pdf',
      method: 'PUT',
      expiresInSeconds: 600,
    });
  });
});

describe('createSignedAssetUrl', () => {
  it('presigns a GET for an already-stored key (read path)', async () => {
    const signer = vi.fn().mockResolvedValue('https://signed.example.com/read');
    const url = await createSignedAssetUrl(CONFIG, 'NICHOLS/PRE_PLAN/PP-1/diagram.pdf', signer);
    expect(url).toBe('https://signed.example.com/read');
    expect(signer).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', key: 'NICHOLS/PRE_PLAN/PP-1/diagram.pdf' }),
    );
  });
});

describe('presignAssetUrl (real SigV4 presigner, no network)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it.each([
    ['PUT', 'PutObject'],
    ['GET', 'GetObject'],
  ] as const)(
    'produces a regional S3 %s URL scoped to the key with a 600s expiry',
    async (method, operation) => {
      process.env.AWS_REGION = 'us-east-1';
      process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
      process.env.AWS_SECRET_ACCESS_KEY = 'secret';
      const url = new URL(
        await presignAssetUrl({
          bucketName: 'boxalarm-dev-platform-assets',
          key: 'NICHOLS/PRE_PLAN/PP-1/diagram.pdf',
          method,
          expiresInSeconds: 600,
        }),
      );
      expect(url.hostname).toBe('boxalarm-dev-platform-assets.s3.us-east-1.amazonaws.com');
      expect(url.pathname).toBe('/NICHOLS/PRE_PLAN/PP-1/diagram.pdf');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
      expect(url.searchParams.get('x-id')).toBe(operation);
      expect(url.hostname).not.toContain('cloudfront');
    },
  );
});

// Review MINOR 4: an upload could be .html/.svg served back to a browser on the bucket origin.
describe('upload allowlist and safe GET overrides', () => {
  it('allows documents and photos, refuses page/script types', () => {
    for (const ok of ['plan.pdf', 'photo.JPG', 'img.heic', 'sheet.xlsx']) {
      expect(isAllowedUploadFilename(ok), ok).toBe(true);
    }
    for (const bad of ['page.html', 'logo.svg', 'x.js', 'noext', 'trailing.']) {
      expect(isAllowedUploadFilename(bad), bad).toBe(false);
    }
  });

  it('maps an extension to its content type case-insensitively', () => {
    expect(uploadContentTypeFor('A/B/photo.JPEG')).toBe('image/jpeg');
    expect(uploadContentTypeFor('x.html')).toBeUndefined();
  });

  it('forces the GET response type from the extension, and a download for anything else', () => {
    expect(safeResponseOverrides('N/PRE_PLAN/P/plan.pdf')).toEqual({
      ResponseContentType: 'application/pdf',
    });
    expect(safeResponseOverrides('N/PRE_PLAN/P/legacy.html')).toEqual({
      ResponseContentType: 'application/octet-stream',
      ResponseContentDisposition: 'attachment',
    });
  });

  it('signs the response-content-type override into a real presigned GET', async () => {
    const originalEnv = { ...process.env };
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    const url = new URL(
      await presignAssetUrl({
        bucketName: 'boxalarm-dev-platform-assets',
        key: 'NICHOLS/PRE_PLAN/PP-1/legacy.html',
        method: 'GET',
        expiresInSeconds: 600,
      }),
    );
    process.env = originalEnv;
    expect(url.searchParams.get('response-content-type')).toBe('application/octet-stream');
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment');
  });
});
