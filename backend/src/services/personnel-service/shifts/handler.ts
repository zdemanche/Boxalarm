import { randomUUID } from 'node:crypto';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyResultV2,
  Handler,
} from 'aws-lambda';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitEmf, emitOutcomeMetric } from '@boxalarm/metrics';
import type { AuthorizerContext } from '../../platform-service/authorizer/handler.js';
import { logError, logInfo } from '../lib/logger.js';
import { getDocClient, readPersonnelTableConfig } from './dynamoClient.js';
import {
  ValidationError,
  buildShiftTransactItems,
  parseCreateShiftRequest,
  parseShiftListItems,
} from './shiftAssembly.js';
import { assembleShiftCoverage, type CoverageStatus } from './coverageAssembly.js';
import {
  buildEligibleQualCodeIndex,
  fetchDeptShiftsWithPositions,
  listDeptShiftMetaItems,
} from './coverageRepository.js';

type ShiftEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;

const OFFICER_ROLES = new Set(['OFFICER', 'ADMIN', 'CHIEF']);
const METRICS_NAMESPACE = 'Boxalarm/PersonnelService';

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
    const rawItems = await listDeptShiftMetaItems(docClient, tableName, deptId);
    const shifts = parseShiftListItems(rawItems);
    return jsonResponse(200, { shifts });
  } catch (error) {
    logHandlerError('shifts.list.query_failed', correlationId, error);
    return problemResponse(503, 'Service Unavailable', 'shifts could not be listed', correlationId);
  }
}

async function handleCoverage(
  event: ShiftEvent,
  correlationId: string,
): Promise<APIGatewayProxyResultV2> {
  const context = event.requestContext.authorizer.lambda;

  // TODO: E8-S3 — replace with Cedar IsAuthorizedWithToken
  if (!hasOfficerRole(context)) {
    return problemResponse(
      403,
      'Forbidden',
      'officer or admin role is required to view shift coverage',
      correlationId,
    );
  }

  const deptId = resolveVerifiedDeptId(context, 'shifts.coverage.invalid_dept', correlationId);
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
    const shifts = await fetchDeptShiftsWithPositions(docClient, tableName, deptId);
    const eligibleQualCodes = await buildEligibleQualCodeIndex(
      docClient,
      tableName,
      deptId,
      correlationId,
    );
    const coverage = shifts.map((shift) => assembleShiftCoverage(shift, eligibleQualCodes));
    const counts = coverage.reduce(
      (acc, shift) => {
        acc[shift.status] += 1;
        return acc;
      },
      { covered: 0, short: 0, 'qual-gapped': 0 } as Record<CoverageStatus, number>,
    );
    emitEmf(METRICS_NAMESPACE, 'ShiftCoverageCovered', counts.covered, [[]]);
    emitEmf(METRICS_NAMESPACE, 'ShiftCoverageShort', counts.short, [[]]);
    emitEmf(METRICS_NAMESPACE, 'ShiftCoverageQualGapped', counts['qual-gapped'], [[]]);
    logInfo('shifts.coverage.read', correlationId, { deptId, shiftCount: coverage.length });
    return jsonResponse(200, { shifts: coverage });
  } catch (error) {
    logError('shifts.coverage.query_failed', correlationId, error);
    emitOutcomeMetric(METRICS_NAMESPACE, 'ShiftCoverageQueryFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'shift coverage could not be computed',
      correlationId,
    );
  }
}

export const handler: Handler<ShiftEvent, APIGatewayProxyResultV2> = async (event) => {
  const correlationId = event.requestContext.requestId;
  const method = event.requestContext.http.method;

  if (method === 'POST') {
    return handleCreate(event, correlationId);
  }
  if (method === 'GET') {
    if (event.requestContext.http.path.endsWith('/coverage')) {
      return handleCoverage(event, correlationId);
    }
    return handleList(event, correlationId);
  }
  return problemResponse(
    405,
    'Method Not Allowed',
    `${method} is not supported on this route`,
    correlationId,
  );
};
