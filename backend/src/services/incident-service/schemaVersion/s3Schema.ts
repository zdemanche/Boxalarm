import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { NerisSchemaDocument, NerisSecondarySchemaDocument } from './entity.js';

async function readBody(body: unknown): Promise<string> {
  const stream = body as { transformToString?: () => Promise<string> } | undefined;
  if (!stream?.transformToString) {
    throw new Error('S3 object body does not support transformToString');
  }
  return stream.transformToString();
}

export async function putSchemaDocument(
  s3: S3Client,
  bucket: string,
  key: string,
  document: NerisSchemaDocument | NerisSecondarySchemaDocument,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(document),
      ContentType: 'application/json',
    }),
  );
}

export async function getCoreSchemaDocument(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<NerisSchemaDocument> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return JSON.parse(await readBody(result.Body)) as NerisSchemaDocument;
}

export async function getSecondarySchemaDocument(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<NerisSecondarySchemaDocument> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return JSON.parse(await readBody(result.Body)) as NerisSecondarySchemaDocument;
}
