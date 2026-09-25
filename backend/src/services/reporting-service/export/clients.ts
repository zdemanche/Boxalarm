import { LambdaClient } from '@aws-sdk/client-lambda';
import { S3Client } from '@aws-sdk/client-s3';

let cachedLambda: LambdaClient | undefined;
let cachedS3: S3Client | undefined;

export function createExportLambdaClient(client?: LambdaClient): LambdaClient {
  cachedLambda ??= client ?? new LambdaClient({});
  return cachedLambda;
}

export function createExportS3Client(client?: S3Client): S3Client {
  cachedS3 ??= client ?? new S3Client({});
  return cachedS3;
}

export function readExportsBucket(env: NodeJS.ProcessEnv): string {
  const bucket = env.EXPORTS_BUCKET_NAME;
  if (!bucket) {
    throw new Error('EXPORTS_BUCKET_NAME is required and was not set');
  }
  return bucket;
}

export function readExportWorkerFunctionName(env: NodeJS.ProcessEnv): string {
  const name = env.REPORTING_EXPORT_WORKER_FUNCTION_NAME;
  if (!name) {
    throw new Error('REPORTING_EXPORT_WORKER_FUNCTION_NAME is required and was not set');
  }
  return name;
}
