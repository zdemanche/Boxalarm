import { randomUUID } from 'node:crypto';
import { QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyResultV2,
  Handler,
} from 'aws-lambda';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../../platform-service/authorizer/handler.js';
import { getDocClient, readPersonnelTableConfig } from './dynamoClient.js';
import {
  ValidationError,
  buildShiftTransactItems,
  parseCreateShiftRequest,
  parseShiftListItems,
} from './shiftAssembly.js';

type ShiftEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;

const OFFICER_ROLES = new Set(['OFFICER', 'ADMIN', 'CHIEF']);
const GSI3_INDEX_NAME = 'gsi3';

function problemResponse(
  status: number,
  title: string,
  detail: string,
  correlationId: string,
): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: 'about:blank',
      title,
      status,
      detail,
      traceId: correlationId,
    }),
  };
}

function jsonResponse(status: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function emitShiftMetric(outcome: 'ShiftCreated' | 'ShiftCreateFailed'): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/PersonnelService',
            Dimensions: [[]],
            Metrics: [{ Name: outcome, Unit: 'Count' }],
          },
        ],
      },
      [outcome]: 1,
    }),
  );
}

function hasOfficerRole(context: AuthorizerContext): boolean {
  const groups = context['cognito:groups'].split(' ').filter((group) => group.length > 0);
  return groups.some((group) => OFFICER_ROLES.has(group.toUpperCase()));
}

function logHandlerError(event: string, correlationId: string, error: unknown): void {
  console.error(
    JSON.stringify({
      event,
      correlationId,
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );
}

function resolveVerifiedDeptId(
  context: AuthorizerContext,
  eventName: string,
  correlationId: string,
): VerifiedDeptId | undefined {
  try {
    return toVerifiedDeptId(context);
  } catch (error) {
    logHandlerError(eventName, correlationId, error);
    return undefined;
  }
}

async function handleCreate(
  event: ShiftEvent,
  correlationId: string,
): Promise<APIGatewayProxyResultV2> {
  const context = event.requestContext.authorizer.lambda;

  // TODO: E8-S3 — replace with Cedar IsAuthorizedWithToken
  if (!hasOfficerRole(context)) {
    return problemResponse(
      403,
      'Forbidden',
      'officer or admin role is required to create a duty shift',
      correlationId,
    );
  }

  let rawBody: unknown;
  try {
    rawBody = event.body ? (JSON.parse(event.body) as unknown) : undefined;
  } catch (error) {
    logHandlerError('shifts.create.invalid_json', correlationId, error);
    return problemResponse(400, 'Bad Request', 'body must be valid JSON', correlationId);
  }

  let input;
  try {
    input = parseCreateShiftRequest(rawBody);
  } catch (error) {
    if (error instanceof ValidationError) {
      return problemResponse(400, 'Bad Request', error.message, correlationId);
    }
    logHandlerError('shifts.create.validation_error', correlationId, error);
    return problemResponse(400, 'Bad Request', 'invalid request body', correlationId);
  }

  const deptId = resolveVerifiedDeptId(context, 'shifts.create.invalid_dept', correlationId);
  if (deptId === undefined) {
    return problemResponse(
      500,
      'Internal Server Error',
      'department context is invalid',
      correlationId,
    );
  }
  const shiftId = randomUUID();

  try {
    const { tableName } = readPersonnelTableConfig(process.env);
    const docClient = getDocClient(process.env);
    const transactItems = buildShiftTransactItems(deptId, shiftId, tableName, input);
    await docClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (error) {
    logHandlerError('shifts.create.write_failed', correlationId, error);
    emitShiftMetric('ShiftCreateFailed');
    return problemResponse(503, 'Service Unavailable', 'shift could not be created', correlationId);
  }

  emitShiftMetric('ShiftCreated');
  return jsonResponse(201, {
    shiftId,
    status: 'OPEN',
    startAt: input.startAt,
    endAt: input.endAt,
    stationId: input.stationId,
    positions: input.positions,
  });
}

async function handleList(
  event: ShiftEvent,
  correlationId: string,
): Promise<APIGatewayProxyResultV2> {
  const context = event.requestContext.authorizer.lambda;
  const deptId = resolveVerifiedDeptId(context, 'shifts.list.invalid_dept', correlationId);
  if (deptId === undefined) {
    return problemResponse(
      500,
      'Internal Server Error',
      'department context is invalid',
      correlationId,
    );
  }

  try {
    const { tableName } = readPersonnelTableConfig(process.env);
    const docClient = getDocClient(process.env);
    const gsi3pk = buildDeptScopedPk(deptId, 'DUTY_SHIFT');
    const rawItems: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: GSI3_INDEX_NAME,
          KeyConditionExpression: 'gsi3pk = :gsi3pk',
          ExpressionAttributeValues: { ':gsi3pk': gsi3pk },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      rawItems.push(...((result.Items ?? []) as Record<string, unknown>[]));
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey !== undefined);
    const shifts = parseShiftListItems(rawItems);
    return jsonResponse(200, { shifts });
  } catch (error) {
    logHandlerError('shifts.list.query_failed', correlationId, error);
    return problemResponse(503, 'Service Unavailable', 'shifts could not be listed', correlationId);
  }
}

export const handler: Handler<ShiftEvent, APIGatewayProxyResultV2> = async (event) => {
  const correlationId = event.requestContext.requestId;
  const method = event.requestContext.http.method;

  if (method === 'POST') {
    return handleCreate(event, correlationId);
  }
  if (method === 'GET') {
    return handleList(event, correlationId);
  }
  return problemResponse(
    405,
    'Method Not Allowed',
    `${method} is not supported on this route`,
    correlationId,
  );
};
