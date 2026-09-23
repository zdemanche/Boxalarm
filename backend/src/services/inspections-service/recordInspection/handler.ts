import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  extractTraceId,
  notFoundProblem,
  serviceUnavailableProblem,
  badRequestProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { getDocumentClient, readInspectionsConfig } from '../dynamoClient.js';
import { emitInspectionMetric } from '../metrics.js';
import {
  ValidationError,
  buildDueGsi2Keys,
  buildInspectionKeys,
  hasInspectionId,
  parseConductPayload,
  parseSchedulePayload,
  toApiInspection,
  type InspectionItem,
} from '../inspectionRecord.js';

function parseBody(event: GuardEvent): unknown {
  if (!event.body) {
    return {};
  }
  try {
    return JSON.parse(event.body);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'inspections.body.malformed',
        service: 'inspections-service',
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
        traceId: extractTraceId(event),
      }),
    );
    return undefined;
  }
}

function bodyStringField(body: unknown, field: string): string | undefined {
  const value =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)[field]
      : undefined;
  return typeof value === 'string' ? value : undefined;
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function logInspectionError(
  event: string,
  error: unknown,
  correlationId: string,
  deptId: string,
): void {
  console.error(
    JSON.stringify({
      event,
      service: 'inspections-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      correlationId,
      deptId,
    }),
  );
}

function logInspectionEvent(event: string, correlationId: string, deptId: string): void {
  console.log(JSON.stringify({ event, service: 'inspections-service', correlationId, deptId }));
}

async function schedule(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const deptId = toVerifiedDeptId(principal);
  let payload;
  try {
    payload = parseSchedulePayload(parseBody(event));
  } catch (error) {
    if (error instanceof ValidationError) {
      return badRequestProblem(traceId, error.detail);
    }
    throw error;
  }

  const { tableName } = readInspectionsConfig(process.env);
  const client = getDocumentClient();
  const { occupancyId, scheduledDate } = payload;

  try {
    const occupancy = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(deptId, 'OCCUPANCY', occupancyId), sk: 'METADATA' },
      }),
    );
    if (!occupancy.Item) {
      emitInspectionMetric('ScheduleFailed');
      return notFoundProblem(traceId, `No occupancy found for occupancyId "${occupancyId}"`);
    }
  } catch (error) {
    logInspectionError('inspections.schedule.occupancyLookupFailed', error, traceId, deptId);
    emitInspectionMetric('ScheduleFailed');
    return serviceUnavailableProblem(traceId);
  }

  const inspectionId = randomUUID();
  const { pk, sk } = buildInspectionKeys(deptId, occupancyId, inspectionId);
  const { gsi2pk, gsi2sk } = buildDueGsi2Keys(deptId, scheduledDate, inspectionId);
  const item: InspectionItem = {
    pk,
    sk,
    entityType: 'INSPECTION_RECORD',
    scheduledDate,
    violations: [],
    nextDueDate: scheduledDate,
    gsi2pk,
    gsi2sk,
  };

  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(sk)',
      }),
    );
  } catch (error) {
    logInspectionError('inspections.schedule.writeFailed', error, traceId, deptId);
    emitInspectionMetric('ScheduleFailed');
    return serviceUnavailableProblem(traceId);
  }

  logInspectionEvent('inspections.scheduled', traceId, deptId);
  emitInspectionMetric('Scheduled');
  return jsonResponse(201, toApiInspection(item));
}

async function conduct(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const deptId = toVerifiedDeptId(principal);
  let payload;
  try {
    payload = parseConductPayload(parseBody(event));
  } catch (error) {
    if (error instanceof ValidationError) {
      return badRequestProblem(traceId, error.detail);
    }
    throw error;
  }

  const { tableName } = readInspectionsConfig(process.env);
  const client = getDocumentClient();
  const { occupancyId, inspectionId, violations } = payload;
  const { pk, sk } = buildInspectionKeys(deptId, occupancyId, inspectionId);
  const conductedDate = new Date().toISOString();

  let updated;
  try {
    updated = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk, sk },
        ConditionExpression: 'attribute_exists(sk)',
        UpdateExpression:
          'SET conductedDate = :conductedDate, conductedBy = :conductedBy, violations = :violations',
        ExpressionAttributeValues: {
          ':conductedDate': conductedDate,
          ':conductedBy': principal.sub,
          ':violations': violations,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      emitInspectionMetric('ConductFailed');
      return notFoundProblem(traceId, 'Inspection not found or not in a conductible state');
    }
    logInspectionError('inspections.conduct.writeFailed', error, traceId, deptId);
    emitInspectionMetric('ConductFailed');
    return serviceUnavailableProblem(traceId);
  }

  logInspectionEvent('inspections.conducted', traceId, deptId);
  emitInspectionMetric('Conducted');
  return jsonResponse(200, toApiInspection(updated.Attributes as InspectionItem));
}

const scheduleHandler = withAuthorization(schedule, {
  actionType: 'Boxalarm::Action',
  actionId: 'ScheduleInspection',
  resourceType: 'Boxalarm::Inspection',
  resourceId: (event) => bodyStringField(parseBody(event), 'occupancyId') ?? 'unknown',
});

const conductHandler = withAuthorization(conduct, {
  actionType: 'Boxalarm::Action',
  actionId: 'ConductInspection',
  resourceType: 'Boxalarm::Inspection',
  resourceId: (event) => bodyStringField(parseBody(event), 'inspectionId') ?? 'unknown',
});

export const handler = async (event: GuardEvent): Promise<APIGatewayProxyResultV2> => {
  const body = parseBody(event);
  return hasInspectionId(body) ? conductHandler(event) : scheduleHandler(event);
};
