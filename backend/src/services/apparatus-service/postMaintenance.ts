import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  extractTraceId,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readApparatusTableConfig } from './dynamoClient.js';
import { buildMaintenanceRecordItem, parseMaintenanceRecordItem } from './maintenanceRecord.js';
import { emitMaintenanceMetric } from './maintenanceMetrics.js';
import { apparatusNotFoundProblem, validationProblem } from './problemDetails.js';
import type { ValidationFieldError } from './problemDetails.js';

interface PostMaintenanceDeps {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly now: () => number;
}

interface ValidatedFields {
  readonly description: string;
  readonly vendor: string;
  readonly cost: number;
  readonly scheduledNextAt: number | null;
  readonly performedAt: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateFields(
  body: Record<string, unknown>,
  defaultPerformedAt: number,
):
  | { readonly ok: true; readonly value: ValidatedFields }
  | { readonly ok: false; readonly errors: readonly ValidationFieldError[] } {
  const errors: ValidationFieldError[] = [];

  if (typeof body.description !== 'string' || body.description.length === 0) {
    errors.push({ field: 'description', message: 'is required and must be a non-empty string' });
  }
  if (typeof body.vendor !== 'string' || body.vendor.length === 0) {
    errors.push({ field: 'vendor', message: 'is required and must be a non-empty string' });
  }
  if (!isFiniteNumber(body.cost)) {
    errors.push({ field: 'cost', message: 'is required and must be a finite number' });
  }

  let scheduledNextAt: number | null = null;
  if (body.scheduledNextAt !== undefined && body.scheduledNextAt !== null) {
    if (!isFiniteNumber(body.scheduledNextAt)) {
      errors.push({
        field: 'scheduledNextAt',
        message: 'must be a finite number (epoch seconds) when provided',
      });
    } else {
      scheduledNextAt = body.scheduledNextAt;
    }
  }

  let performedAt = defaultPerformedAt;
  if (body.performedAt !== undefined) {
    if (!isFiniteNumber(body.performedAt)) {
      errors.push({
        field: 'performedAt',
        message: 'must be a finite number (epoch seconds) when provided',
      });
    } else {
      performedAt = body.performedAt;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      description: body.description as string,
      vendor: body.vendor as string,
      cost: body.cost as number,
      scheduledNextAt,
      performedAt,
    },
  };
}

async function postMaintenance(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: PostMaintenanceDeps,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const apparatusId = event.pathParameters?.unitId;
  if (!apparatusId) {
    return apparatusNotFoundProblem(traceId);
  }
  const deptId = toVerifiedDeptId(principal);

  let rawBody: Record<string, unknown>;
  try {
    rawBody = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'maintenance.validation_failed',
        reason: 'MalformedJson',
        correlationId: traceId,
        deptId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return validationProblem(traceId, [{ field: 'body', message: 'must be valid JSON' }]);
  }

  const validation = validateFields(rawBody, deps.now());
  if (!validation.ok) {
    return validationProblem(traceId, validation.errors);
  }

  const existing = await deps.client.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'APPARATUS', apparatusId), sk: 'METADATA' },
    }),
  );
  if (!existing.Item) {
    return apparatusNotFoundProblem(traceId);
  }

  const item = buildMaintenanceRecordItem(deptId, apparatusId, validation.value);

  try {
    await deps.client.send(new PutCommand({ TableName: deps.tableName, Item: item }));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'maintenance.put_failed',
        correlationId: traceId,
        deptId,
        apparatusId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    emitMaintenanceMetric('LogFailed');
    throw error;
  }
  emitMaintenanceMetric('Logged');

  return {
    statusCode: 201,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parseMaintenanceRecordItem(item, apparatusId, deptId)),
  };
}

interface PostMaintenanceOverrides {
  readonly client?: DynamoDBDocumentClient;
  readonly tableName?: string;
  readonly now?: () => number;
  readonly authzClient?: VerifiedPermissionsClient;
}

function resolveDeps(overrides: PostMaintenanceOverrides): PostMaintenanceDeps {
  return {
    client: overrides.client ?? createDynamoClient(process.env),
    tableName: overrides.tableName ?? readApparatusTableConfig(process.env).tableName,
    now: overrides.now ?? (() => Math.floor(Date.now() / 1000)),
  };
}

export function createPostMaintenanceHandler(
  overrides: PostMaintenanceOverrides = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    (event, principal) => postMaintenance(event, principal, resolveDeps(overrides)),
    {
      actionType: 'Boxalarm::Action',
      actionId: 'LogMaintenanceRecord',
      resourceType: 'Boxalarm::Apparatus',
      resourceId: (event) => event.pathParameters?.unitId ?? '',
      ...(overrides.authzClient !== undefined ? { client: overrides.authzClient } : {}),
    },
  );
}

export const handler = createPostMaintenanceHandler();
