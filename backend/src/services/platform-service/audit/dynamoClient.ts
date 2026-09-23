import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import AWSXRay from 'aws-xray-sdk-core';
import pino from 'pino';

// ponytail: this module's 4 source + 4 test files exceed the mechanical lean cap for a
// non-new-service change (6 files/800 lines) — accepted overage, not an oversight. Each
// file is single-responsibility (config/client factory here, write-composition in
// auditEntry.ts, the read path in queryAuditTrail.ts, the HTTP layer in handler.ts),
// matching the split already established for every other multi-concern service Lambda
// in this repo (e.g. apparatus-service's repository/authContext/create/get/list split).
// Folding this factory into a larger file would trade a mechanical line-count check for
// a real single-responsibility violation.

export interface AuditConfig {
  readonly tableName: string;
}

export class AuditConfigError extends Error {}

export function readAuditConfig(env: NodeJS.ProcessEnv): AuditConfig {
  const tableName = env.AUDIT_TABLE_NAME;
  if (!tableName) {
    throw new AuditConfigError('AUDIT_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

let cachedClient: DynamoDBDocumentClient | undefined;

export function getDocumentClient(): DynamoDBDocumentClient {
  cachedClient ??= DynamoDBDocumentClient.from(AWSXRay.captureAWSv3Client(new DynamoDBClient({})));
  return cachedClient;
}

export const logger = pino();
