import { randomBytes } from 'node:crypto';
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  extractTraceId,
  notFoundProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { createLogger } from '@boxalarm/logging';
import { getDynamoDocClient } from '../export/awsClients.js';
import { ConflictError, putDepartmentConfig } from '../config/repository.js';
import { CAD_INGRESS, loadCadIngress, readTableName } from './repository.js';
import { readStoredSources, withWebhookKey } from './model.js';

/**
 * POST /api/v1/platform/cad-sources/{sourceId}/webhook-key (CHIEF/ADMIN, Cedar
 * ManageCadIngress): mint a new HMAC key for one CAD source's webhook and return it ONCE.
 *
 * The secret `{prefix}{deptId}-{sourceId}` holds `{ current, previous }`: the old current key
 * becomes previous, so the CAD keeps working until its operator installs the new key, and
 * the webhook accepts either (cad-ingress-auth: two active keys). The next rotation retires
 * it. The key is never stored anywhere else, never logged, and never returned by GET.
 *
 * This Lambda is the only one with the secret write grant (infrastructure: name-prefix
 * scoped); the webhook Lambda can only read.
 */

const logger = createLogger({ service: 'platform-service' });
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

let client: SecretsManagerClient | undefined;
function secrets(): SecretsManagerClient {
  client ??= new SecretsManagerClient({});
  return client;
}

/** Test seam. */
export function setSecretsClient(override: SecretsManagerClient | undefined): void {
  client = override;
}

function secretName(deptId: VerifiedDeptId, sourceId: string): string {
  const prefix = process.env.CAD_WEBHOOK_SECRET_PREFIX;
  if (!prefix) throw new Error('CAD_WEBHOOK_SECRET_PREFIX is required and was not set');
  return `${prefix}${deptId}-${sourceId}`;
}

async function readCurrentKey(name: string): Promise<string | undefined> {
  try {
    const output = await secrets().send(new GetSecretValueCommand({ SecretId: name }));
    const parsed = JSON.parse(output.SecretString ?? '{}') as { current?: unknown };
    return typeof parsed.current === 'string' ? parsed.current : undefined;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return undefined;
    throw error;
  }
}

async function writeKeys(name: string, current: string, previous: string | undefined) {
  const value = JSON.stringify(previous ? { current, previous } : { current });
  try {
    await secrets().send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
    await secrets().send(
      new CreateSecretCommand({
        Name: name,
        Description: 'CAD webhook HMAC keys { current, previous } (Boxalarm CAD ingress)',
        SecretString: value,
      }),
    );
  }
}

async function rotate(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const deptId = toVerifiedDeptId(principal);
  const sourceId = event.pathParameters?.sourceId ?? '';
  const current = await loadCadIngress(deptId);
  const stored = readStoredSources(current?.value);
  if (!current || !SOURCE_ID.test(sourceId) || !stored.some((s) => s.sourceId === sourceId)) {
    return notFoundProblem(traceId, 'Save the CAD source before creating its webhook key.');
  }

  const name = secretName(deptId, sourceId);
  const key = randomBytes(32).toString('hex');
  await writeKeys(name, key, await readCurrentKey(name));

  const rotatedAt = new Date().toISOString();
  const keyId = `${deptId}.${sourceId}`;
  let config = current;
  for (let attempt = 0; ; attempt++) {
    try {
      await putDepartmentConfig(getDynamoDocClient(), {
        tableName: readTableName(),
        deptId,
        configType: CAD_INGRESS,
        value: {
          sources: withWebhookKey(readStoredSources(config.value), sourceId, {
            keyId,
            secretName: name,
            rotatedAt,
          }),
        },
        actorId: principal.sub,
        correlationId: traceId,
        expectedVersion: config.version,
      });
      break;
    } catch (error) {
      // A concurrent settings save: re-read and apply the key reference to the newer version.
      if (!(error instanceof ConflictError) || attempt >= 2) throw error;
      const reloaded = await loadCadIngress(deptId);
      if (!reloaded) throw error;
      config = reloaded;
    }
  }

  logger.info({
    event: 'platform.cadSources.webhookKeyRotated',
    correlationId: traceId,
    actorId: principal.sub,
    sourceId,
  });
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({
      keyId,
      secret: key,
      rotatedAt,
      previousKeyStillValid: true,
      webhookUrl: process.env.CAD_WEBHOOK_URL || null,
    }),
  };
}

export const handler = withAuthorization(rotate, {
  actionType: 'Boxalarm::Action',
  actionId: 'ManageCadIngress',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
