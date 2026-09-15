import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  badRequestProblem,
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoClient, readApparatusServiceConfig } from './dynamoClient.js';
import {
  buildChecklistAuditEntry,
  buildChecklistIdempotencyLockItem,
  buildChecklistRunItem,
  parseChecklistRunItem,
  validateSubmitCheckBody,
} from './checklistRun.js';
import { resolveApparatusIdByUnitId } from './checklistResolution.js';
import { logError } from './logger.js';
import {
  apparatusNotFoundProblem,
  checklistRunConflictProblem,
  validationProblem,
} from './problemDetails.js';

interface PostChecksDeps {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly now: () => number;
}

const CHECK_TRANSACT_INDEX = 0;
const LOCK_TRANSACT_INDEX = 1;

function emitChecksMetric(outcome: 'Created' | 'DuplicateAccepted' | 'Conflict' | 'Error'): void {
  emitOutcomeMetric('Boxalarm/ApparatusService', `SubmitCheck${outcome}`);
}

function logChecksError(operation: string, error: unknown, correlationId: string): void {
  logError({
    event: 'apparatus.checks.error',
    service: 'apparatus-service',
    operation,
    reason: error instanceof Error ? error.constructor.name : 'UnknownError',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    correlationId,
  });
}

function cancellationCode(error: TransactionCanceledException, index: number): string | undefined {
  return error.CancellationReasons?.[index]?.Code;
}

async function postChecks(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: PostChecksDeps,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const unitId = event.pathParameters?.unitId;
  if (!unitId || unitId.trim().length === 0) {
    return badRequestProblem(traceId, 'unitId path parameter is required');
  }
  const deptId = toVerifiedDeptId(principal);

  let rawBody: Record<string, unknown>;
  try {
    rawBody = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
  } catch (error) {
    logError({
      event: 'checks.validation_failed',
      reason: 'MalformedJson',
      correlationId: traceId,
      deptId,
      error: error instanceof Error ? error.message : String(error),
    });
    return validationProblem(traceId, [{ field: 'body', message: 'must be valid JSON' }]);
  }

  const validation = validateSubmitCheckBody(rawBody);
  if (!validation.ok) {
    return validationProblem(traceId, validation.errors);
  }

  if (validation.value.completedBy !== principal.sub) {
    return validationProblem(traceId, [
      { field: 'completedBy', message: 'must match the authenticated principal' },
    ]);
  }

  let operation = 'resolveApparatus';
  try {
    const apparatusId = await resolveApparatusIdByUnitId(
      deps.client,
      deps.tableName,
      deptId,
      unitId,
    );
    if (!apparatusId) {
      emitChecksMetric('Error');
      return apparatusNotFoundProblem(traceId);
    }

    const item = buildChecklistRunItem(deptId, apparatusId, validation.value);
    const checkSk = item.sk as string;
    const lockItem = buildChecklistIdempotencyLockItem(
      deptId,
      validation.value.idempotencyKey,
      checkSk,
    );
    const auditEntry = buildChecklistAuditEntry(
      deptId,
      apparatusId,
      validation.value.completedAt,
      principal.sub,
      deps.now(),
    );

    operation = 'putChecklistRun';
    try {
      await deps.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: deps.tableName,
                Item: item,
                ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
              },
            },
            {
              Put: {
                TableName: deps.tableName,
                Item: lockItem,
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            { Put: { TableName: deps.tableName, Item: auditEntry } },
          ],
        }),
      );
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) {
        throw error;
      }
      const lockFailed = cancellationCode(error, LOCK_TRANSACT_INDEX) === 'ConditionalCheckFailed';
      const checkFailed =
        cancellationCode(error, CHECK_TRANSACT_INDEX) === 'ConditionalCheckFailed';
      if (!lockFailed && !checkFailed) {
        throw error;
      }

      operation = 'reclassifyReplay';
      if (lockFailed) {
        const existingLock = await deps.client.send(
          new GetCommand({
            TableName: deps.tableName,
            Key: {
              pk: buildDeptScopedPk(deptId, 'CHECK_IDEMPOTENCY', validation.value.idempotencyKey),
              sk: 'LOCK',
            },
            ConsistentRead: true,
          }),
        );
        const existingLockItem = existingLock.Item;
        if (!existingLockItem) {
          throw new Error(
            'Idempotency lock reported a conflict but the lock item could not be read back',
          );
        }
        const existingCheck = await deps.client.send(
          new GetCommand({
            TableName: deps.tableName,
            Key: {
              pk: buildDeptScopedPk(deptId, 'APPARATUS', apparatusId),
              sk: existingLockItem.checkSk as string,
            },
            ConsistentRead: true,
          }),
        );
        if (!existingCheck.Item) {
          throw new Error(
            'Idempotency lock exists but the referenced checklist run could not be read back',
          );
        }
        emitChecksMetric('DuplicateAccepted');
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(parseChecklistRunItem(existingCheck.Item, apparatusId, deptId)),
        };
      }

      const existing = await deps.client.send(
        new GetCommand({
          TableName: deps.tableName,
          Key: { pk: buildDeptScopedPk(deptId, 'APPARATUS', apparatusId), sk: checkSk },
          ConsistentRead: true,
        }),
      );
      const existingItem = existing.Item;
      if (!existingItem) {
        throw new Error(
          'Checklist run conditional write failed but the existing item could not be read back',
        );
      }
      if (existingItem.idempotencyKey === validation.value.idempotencyKey) {
        emitChecksMetric('DuplicateAccepted');
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(parseChecklistRunItem(existingItem, apparatusId, deptId)),
        };
      }
      emitChecksMetric('Conflict');
      return checklistRunConflictProblem(traceId);
    }

    emitChecksMetric('Created');
    return {
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parseChecklistRunItem(item, apparatusId, deptId)),
    };
  } catch (error) {
    logChecksError(operation, error, traceId);
    emitChecksMetric('Error');
    return serviceUnavailableProblem(traceId);
  }
}

interface PostChecksOverrides {
  readonly client?: DynamoDBDocumentClient;
  readonly tableName?: string;
  readonly now?: () => number;
  readonly authzClient?: VerifiedPermissionsClient;
}

function resolveDeps(overrides: PostChecksOverrides): PostChecksDeps {
  return {
    client: overrides.client ?? createDynamoClient(process.env),
    tableName: overrides.tableName ?? readApparatusServiceConfig(process.env).tableName,
    now: overrides.now ?? (() => Math.floor(Date.now() / 1000)),
  };
}

export function createPostChecksHandler(
  overrides: PostChecksOverrides = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    (event, principal) => postChecks(event, principal, resolveDeps(overrides)),
    {
      actionType: 'Boxalarm::Action',
      actionId: 'SubmitApparatusCheck',
      resourceType: 'Boxalarm::Apparatus',
      resourceId: (event) => event.pathParameters?.unitId ?? '',
      ...(overrides.authzClient !== undefined ? { client: overrides.authzClient } : {}),
    },
  );
}

export const handler = createPostChecksHandler();
