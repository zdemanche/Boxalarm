import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { captureAWSv3Client } from 'aws-xray-sdk-core';

let cachedDocClient: DynamoDBDocumentClient | undefined;
let cachedS3Client: S3Client | undefined;
let cachedLambdaClient: LambdaClient | undefined;

export function getDynamoDocClient(client?: DynamoDBDocumentClient): DynamoDBDocumentClient {
  if (client) {
    return client;
  }
  cachedDocClient ??= DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient({})));
  return cachedDocClient;
}

export function getS3Client(client?: S3Client): S3Client {
  if (client) {
    return client;
  }
  cachedS3Client ??= captureAWSv3Client(new S3Client({}));
  return cachedS3Client;
}

export function getLambdaClient(client?: LambdaClient): LambdaClient {
  if (client) {
    return client;
  }
  cachedLambdaClient ??= captureAWSv3Client(new LambdaClient({}));
  return cachedLambdaClient;
}
