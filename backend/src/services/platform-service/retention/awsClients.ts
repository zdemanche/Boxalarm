import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { KMSClient } from '@aws-sdk/client-kms';
import { captureAWSv3Client } from 'aws-xray-sdk-core';

let cachedDocClient: DynamoDBDocumentClient | undefined;
let cachedKmsClient: KMSClient | undefined;

export function getDynamoDocClient(client?: DynamoDBDocumentClient): DynamoDBDocumentClient {
  if (client) {
    return client;
  }
  cachedDocClient ??= DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient({})));
  return cachedDocClient;
}

export function getKmsClient(client?: KMSClient): KMSClient {
  if (client) {
    return client;
  }
  cachedKmsClient ??= captureAWSv3Client(new KMSClient({}));
  return cachedKmsClient;
}
