import {
  APIGatewayClient,
  CreateApiKeyCommand,
  CreateUsagePlanKeyCommand,
  DeleteApiKeyCommand,
  NotFoundException,
} from '@aws-sdk/client-api-gateway';
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
  conflictProblem,
  extractTraceId,
  notFoundProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { createLogger } from '@boxalarm/logging';
import { getDynamoDocClient } from '../export/awsClients.js';
import { ConflictError, putDepartmentConfig } from '../config/repository.js';
import { CAD_INGRESS, loadCadIngress, readTableName } from './repository.js';
import { readStoredSources, withWebhookKey, type WebhookKeyRef } from './model.js';

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

let apiGateway: APIGatewayClient | undefined;

/** Test seam. */
export function setApiGatewayClient(override: APIGatewayClient | undefined): void {
  apiGateway = override;
}

function gateway(): APIGatewayClient {
  apiGateway ??= new APIGatewayClient({});
  return apiGateway;
}

/**
 * A new API key for the source, attached to the webhook's usage plan: its own throttle bucket
 * (security review M4). The value is random; it partitions capacity and is not a credential -
 * the HMAC is. Tagged so the delete grant can be limited to CAD keys.
 */
async function createSourceApiKey(
  deptId: string,
  sourceId: string,
  rotatedAtSeconds: number,
): Promise<{ readonly id: string; readonly value: string }> {
  const usagePlanId = process.env.CAD_WEBHOOK_USAGE_PLAN_ID;
  if (!usagePlanId) throw new Error('CAD_WEBHOOK_USAGE_PLAN_ID is required and was not set');
  const value = randomBytes(24).toString('base64url');
  const created = await gateway().send(
    new CreateApiKeyCommand({
      name: `${process.env.CAD_WEBHOOK_SECRET_PREFIX ?? 'cad-webhook/'}${deptId}/${sourceId}/${rotatedAtSeconds}`,
      enabled: true,
      value,
      tags: {
        'boxalarm:deptId': deptId,
        'boxalarm:sourceId': sourceId,
        'boxalarm:purpose': 'cad-webhook',
      },
    }),
  );
  if (!created.id) throw new Error('API Gateway returned no API key id');
  await gateway().send(
    new CreateUsagePlanKeyCommand({ usagePlanId, keyId: created.id, keyType: 'API_KEY' }),
  );
  return { id: created.id, value };
}

/** Deletes a replaced API key; a key already gone is fine. Never throws (logged). */
export async function deleteSourceApiKey(apiKeyId: string | undefined, correlationId: string) {
  if (!apiKeyId) return;
  try {
    await gateway().send(new DeleteApiKeyCommand({ apiKey: apiKeyId }));
  } catch (error) {
    if (error instanceof NotFoundException) return;
    logger.error({
      event: 'platform.cadSources.apiKeyDeleteFailed',
      correlationId,
      message: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

let client: SecretsManagerClient | undefined;
function secrets(): SecretsManagerClient {
  client ??= new SecretsManagerClient({});
  return client;
}

/** Test seam. */
export function setSecretsClient(override: SecretsManagerClient | undefined): void {
  client = override;
}

/**
 * `{prefix}{deptId}/{sourceId}` - '/' can occur in neither part (deptIds are [A-Za-z0-9_-],
 * sourceIds [a-z0-9-]), so two departments' sources can never name the same secret (security
 * review M1: with '-' as the separator, dept "nichols" source "fd-county" and dept "nichols-fd"
 * source "county" collided and one chief could mint the other's key).
 */
export function cadWebhookSecretName(prefix: string, deptId: string, sourceId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(deptId) || !SOURCE_ID.test(sourceId)) {
    throw new Error('deptId or sourceId cannot name a CAD webhook secret');
  }
  return `${prefix}${deptId}/${sourceId}`;
}

function secretName(deptId: VerifiedDeptId, sourceId: string): string {
  const prefix = process.env.CAD_WEBHOOK_SECRET_PREFIX;
  if (!prefix) throw new Error('CAD_WEBHOOK_SECRET_PREFIX is required and was not set');
  return cadWebhookSecretName(prefix, deptId, sourceId);
}

/** The secret's value: its owner, so ingress can refuse a secret that is not this source's. */
interface WebhookSecretValue {
  readonly deptId: string;
  readonly sourceId: string;
  readonly current: string;
  readonly previous?: string;
  /** Epoch seconds after which ingress stops accepting `previous` (security review M5). */
  readonly previousExpiresAt?: number;
}

/**
 * How long the key a rotation replaces keeps working: long enough to install the new one on
 * the CAD, short enough that one rotation after a leak does end the leaked key (security
 * review M5). "Revoke previous now" ends it at once.
 */
export const PREVIOUS_KEY_GRACE_SECONDS = 24 * 60 * 60;

export class SecretOwnerMismatchError extends Error {
  constructor() {
    super('the CAD webhook secret belongs to another department or source');
    this.name = 'SecretOwnerMismatchError';
  }
}

async function readSecret(
  name: string,
  owner: { deptId: string; sourceId: string },
): Promise<WebhookSecretValue | undefined> {
  try {
    const output = await secrets().send(new GetSecretValueCommand({ SecretId: name }));
    const parsed = JSON.parse(output.SecretString ?? '{}') as Partial<WebhookSecretValue>;
    if (parsed.deptId !== owner.deptId || parsed.sourceId !== owner.sourceId) {
      throw new SecretOwnerMismatchError();
    }
    return parsed as WebhookSecretValue;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return undefined;
    throw error;
  }
}

async function writeSecret(name: string, value: WebhookSecretValue, exists: boolean) {
  const secretString = JSON.stringify(value);
  if (exists) {
    await secrets().send(new PutSecretValueCommand({ SecretId: name, SecretString: secretString }));
    return;
  }
  await secrets().send(
    new CreateSecretCommand({
      Name: name,
      Description: 'CAD webhook HMAC keys (Boxalarm CAD ingress)',
      SecretString: secretString,
      Tags: [
        { Key: 'boxalarm:deptId', Value: value.deptId },
        { Key: 'boxalarm:sourceId', Value: value.sourceId },
        { Key: 'boxalarm:purpose', Value: 'cad-webhook' },
      ],
    }),
  );
}

const LEASE_SECONDS = 30;
const LEASE_CONFLICT =
  'Another key change for this source is in progress. Wait a moment, reload and try again.';

function leaseKey(deptId: VerifiedDeptId, sourceId: string) {
  return { pk: buildDeptScopedPk(deptId), sk: `CADKEY_LOCK#${sourceId}` };
}

/**
 * Secrets Manager has no conditional write, so key changes for one source are serialised here:
 * a lease row in the department's partition, taken before the secret is read and released
 * when the change ends (or expires after LEASE_SECONDS if this Lambda dies).
 */
async function acquireLease(
  deptId: VerifiedDeptId,
  sourceId: string,
  owner: string,
): Promise<boolean> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  try {
    await getDynamoDocClient().send(
      new PutCommand({
        TableName: readTableName(),
        Item: {
          ...leaseKey(deptId, sourceId),
          entityType: 'CAD_KEY_LOCK',
          owner,
          leaseUntil: nowSeconds + LEASE_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(pk) OR leaseUntil < :now',
        ExpressionAttributeValues: { ':now': nowSeconds },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}

async function releaseLease(deptId: VerifiedDeptId, sourceId: string, owner: string) {
  try {
    await getDynamoDocClient().send(
      new PutCommand({
        TableName: readTableName(),
        Item: {
          ...leaseKey(deptId, sourceId),
          entityType: 'CAD_KEY_LOCK',
          owner,
          leaseUntil: 0,
        },
        ConditionExpression: '#owner = :owner',
        ExpressionAttributeNames: { '#owner': 'owner' },
        ExpressionAttributeValues: { ':owner': owner },
      }),
    );
  } catch (error) {
    logger.error({
      event: 'platform.cadSources.leaseReleaseFailed',
      correlationId: owner,
      message: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

/** Puts the secret back as it was if this rotation's key is still the one it holds. */
async function restoreSecret(
  name: string,
  owner: { deptId: string; sourceId: string },
  key: string,
  existing: WebhookSecretValue | undefined,
  correlationId: string,
) {
  try {
    const held = await readSecret(name, owner);
    if (held?.current === key && existing) await writeSecret(name, existing, true);
  } catch (error) {
    logger.error({
      event: 'platform.cadSources.secretRestoreFailed',
      correlationId,
      message: error instanceof Error ? error.message : 'unknown error',
    });
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
  if (!(await acquireLease(deptId, sourceId, traceId))) {
    return conflictProblem(traceId, LEASE_CONFLICT);
  }
  try {
    return await rotateLeased(traceId, principal, deptId, sourceId, current);
  } finally {
    await releaseLease(deptId, sourceId, traceId);
  }
}

async function rotateLeased(
  traceId: string,
  principal: CedarPrincipalContext,
  deptId: VerifiedDeptId,
  sourceId: string,
  loaded: NonNullable<Awaited<ReturnType<typeof loadCadIngress>>>,
): Promise<APIGatewayProxyResultV2> {
  const name = secretName(deptId, sourceId);
  const key = randomBytes(32).toString('hex');
  const owner = { deptId, sourceId };
  let existing: WebhookSecretValue | undefined;
  try {
    existing = await readSecret(name, owner);
  } catch (error) {
    if (error instanceof SecretOwnerMismatchError) {
      logger.error({ event: 'platform.cadSources.secretOwnerMismatch', correlationId: traceId });
      return conflictProblem(
        traceId,
        'This source cannot be keyed; contact the platform operator.',
      );
    }
    throw error;
  }
  // A secret the saved config does not reference is an orphan (its source was removed and
  // re-created): its key is not inherited as `previous` (security review M5).
  const inheritedKey =
    readStoredSources(loaded.value).find((source) => source.sourceId === sourceId)?.webhookKey
      ?.secretName === name
      ? existing?.current
      : undefined;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const previousExpiresAt = nowSeconds + PREVIOUS_KEY_GRACE_SECONDS;
  const rotatedAt = new Date(nowSeconds * 1000).toISOString();
  const keyId = `${deptId}.${sourceId}`;
  // The CAD sends the new API key with the new HMAC key. Created before the secret changes, so a
  // failure here leaves the live key untouched.
  const apiKey = await createSourceApiKey(deptId, sourceId, nowSeconds);
  let previousRef: WebhookKeyRef | undefined;
  try {
    await writeSecret(
      name,
      {
        ...owner,
        current: key,
        ...(inheritedKey ? { previous: inheritedKey, previousExpiresAt } : {}),
      },
      existing !== undefined,
    );
    const written = await readSecret(name, owner);
    if (written?.current !== key) {
      await deleteSourceApiKey(apiKey.id, traceId);
      return conflictProblem(
        traceId,
        'Another key rotation for this source happened at the same time. Reload and rotate again.',
      );
    }
    let config = loaded;
    for (let attempt = 0; ; attempt++) {
      previousRef = readStoredSources(config.value).find(
        (source) => source.sourceId === sourceId,
      )?.webhookKey;
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
              apiKeyId: apiKey.id,
              ...(previousRef?.apiKeyId ? { previousApiKeyId: previousRef.apiKeyId } : {}),
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
  } catch (error) {
    logger.error({
      event: 'platform.cadSources.webhookKeyRotationFailed',
      correlationId: traceId,
      sourceId,
      message: error instanceof Error ? error.message : 'unknown error',
    });
    await restoreSecret(name, owner, key, existing, traceId);
    await deleteSourceApiKey(apiKey.id, traceId);
    throw error;
  }
  // The one before the previous is deleted once the new reference is saved.
  await deleteSourceApiKey(previousRef?.previousApiKeyId, traceId);

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
      apiKey: apiKey.value,
      rotatedAt,
      previousKeyStillValid: inheritedKey !== undefined,
      previousKeyExpiresAt:
        inheritedKey !== undefined ? new Date(previousExpiresAt * 1000).toISOString() : null,
      webhookUrl: process.env.CAD_WEBHOOK_URL ? `${process.env.CAD_WEBHOOK_URL}/${keyId}` : null,
    }),
  };
}

/**
 * POST .../webhook-key/revoke-previous: the key a rotation replaced stops working now, not in
 * 24 h (a leak). The current key is untouched.
 */
async function revokePrevious(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const deptId = toVerifiedDeptId(principal);
  const sourceId = event.pathParameters?.sourceId ?? '';
  if (!SOURCE_ID.test(sourceId)) return notFoundProblem(traceId, 'No such CAD source.');
  if (!(await acquireLease(deptId, sourceId, traceId))) {
    return conflictProblem(traceId, LEASE_CONFLICT);
  }
  try {
    return await revokeLeased(traceId, principal, deptId, sourceId);
  } finally {
    await releaseLease(deptId, sourceId, traceId);
  }
}

async function revokeLeased(
  traceId: string,
  principal: CedarPrincipalContext,
  deptId: VerifiedDeptId,
  sourceId: string,
): Promise<APIGatewayProxyResultV2> {
  const name = secretName(deptId, sourceId);
  const owner = { deptId, sourceId };
  let existing: WebhookSecretValue | undefined;
  try {
    existing = await readSecret(name, owner);
  } catch (error) {
    if (error instanceof SecretOwnerMismatchError) {
      return conflictProblem(
        traceId,
        'This source cannot be keyed; contact the platform operator.',
      );
    }
    throw error;
  }
  if (!existing) return notFoundProblem(traceId, 'This source has no webhook key.');
  await writeSecret(name, { ...owner, current: existing.current }, true);
  const config = await loadCadIngress(deptId);
  const ref = readStoredSources(config?.value).find((s) => s.sourceId === sourceId)?.webhookKey;
  await deleteSourceApiKey(ref?.previousApiKeyId, traceId);
  logger.info({
    event: 'platform.cadSources.previousKeyRevoked',
    correlationId: traceId,
    actorId: principal.sub,
    sourceId,
  });
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId, previousKeyRevoked: true }),
  };
}

const AUTHZ = {
  actionType: 'Boxalarm::Action',
  actionId: 'ManageCadIngress',
  resourceType: 'Boxalarm::Department',
  resourceId: (event: GuardEvent) => event.requestContext.authorizer?.lambda?.deptId ?? '',
} as const;

const rotateHandler = withAuthorization(rotate, AUTHZ);
const revokeHandler = withAuthorization(revokePrevious, AUTHZ);

export const handler = async (event: GuardEvent): Promise<APIGatewayProxyResultV2> =>
  event.routeKey === 'POST /api/v1/platform/cad-sources/{sourceId}/webhook-key/revoke-previous'
    ? revokeHandler(event)
    : rotateHandler(event);
