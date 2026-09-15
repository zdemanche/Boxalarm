import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';

let cachedClient: DynamoDBDocumentClient | undefined;

export function getDynamoDocumentClient(override?: DynamoDBDocumentClient): DynamoDBDocumentClient {
  // override: test seam only — production callers omit it and get the X-Ray-instrumented
  // singleton, mirroring packages/authz/src/client.ts:createAuthzClient.
  cachedClient ??=
    override ?? DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient({})));
  return cachedClient;
}
