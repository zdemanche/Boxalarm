import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  extractTraceId,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { getDynamoDocClient } from './awsClients.js';
import {
  RetentionConfigConflictError,
  getRetentionConfig,
  putRetentionConfig,
} from './configRepository.js';

interface Deps {
  readonly docClient?: DynamoDBDocumentClient;
}

interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly traceId: string;
}

function problemResponse(
  status: number,
  title: string,
  detail: string,
  traceId: string,
): APIGatewayProxyResultV2 {
  const body: ProblemDetails = { type: 'about:blank', title, status, detail, traceId };
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify(body),
  };
}

function jsonResponse(status: number, payload: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function log(
  level: 'log' | 'error',
  event: string,
  fields: Record<string, unknown>,
  traceId: string,
): void {
  console[level](
    JSON.stringify({ service: 'platform-service', correlationId: traceId, event, ...fields }),
  );
}

function errorContext(error: unknown): { reason: string; message: string } {
  return {
    reason: error instanceof Error ? error.constructor.name : 'UnknownError',
    message: error instanceof Error ? error.message : String(error),
  };
}

function parseRetentionYears(body: string | undefined): number | { error: string } {
  let raw: unknown;
  try {
    raw = body ? JSON.parse(body) : {};
  } catch {
    return { error: 'Request body must be valid JSON.' };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { error: 'Request body must be a JSON object.' };
  }
  const retentionYears = (raw as Record<string, unknown>).retentionYears;
  if (
    typeof retentionYears !== 'number' ||
    !Number.isInteger(retentionYears) ||
    retentionYears < 1
  ) {
    return { error: 'retentionYears must be a positive integer.' };
  }
  return retentionYears;
}

async function handleGet(
  deptId: VerifiedDeptId,
  traceId: string,
  deps: Deps,
): Promise<APIGatewayProxyResultV2> {
  try {
    const docClient = getDynamoDocClient(deps.docClient);
    const config = await getRetentionConfig(docClient, deptId);
    return jsonResponse(200, config);
  } catch (error) {
    log('error', 'retention.config.get.failed', errorContext(error), traceId);
    return problemResponse(
      503,
      'Retention config unavailable',
      'Unable to read retention configuration.',
      traceId,
    );
  }
}

async function handlePut(
  deptId: VerifiedDeptId,
  actorId: string,
  body: string | undefined,
  traceId: string,
  deps: Deps,
): Promise<APIGatewayProxyResultV2> {
  const parsed = parseRetentionYears(body);
  if (typeof parsed === 'object') {
    return problemResponse(400, 'Bad Request', parsed.error, traceId);
  }

  try {
    const docClient = getDynamoDocClient(deps.docClient);
    const record = await putRetentionConfig(docClient, {
      deptId,
      retentionYears: parsed,
      actorId,
    });
    return jsonResponse(200, record);
  } catch (error) {
    if (error instanceof RetentionConfigConflictError) {
      log('error', 'retention.config.put.conflict', errorContext(error), traceId);
      return problemResponse(409, 'Conflict', error.message, traceId);
    }
    log('error', 'retention.config.put.failed', errorContext(error), traceId);
    return problemResponse(
      503,
      'Retention config unavailable',
      'Unable to store retention configuration.',
      traceId,
    );
  }
}

function resourceId(event: GuardEvent): string {
  return event.requestContext.authorizer?.lambda?.deptId ?? '';
}

function createGetHandler(deps: Deps): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    async (event: GuardEvent, principal: CedarPrincipalContext) => {
      const traceId = extractTraceId(event);
      const deptId = toVerifiedDeptId(principal);
      return handleGet(deptId, traceId, deps);
    },
    {
      actionType: 'Boxalarm::Action',
      actionId: 'ViewRetentionConfig',
      resourceType: 'Boxalarm::Department',
      resourceId,
    },
  );
}

function createPutHandler(deps: Deps): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    async (event: GuardEvent, principal: CedarPrincipalContext) => {
      const traceId = extractTraceId(event);
      const deptId = toVerifiedDeptId(principal);
      return handlePut(deptId, principal.sub, event.body, traceId, deps);
    },
    {
      actionType: 'Boxalarm::Action',
      actionId: 'UpdateRetentionConfig',
      resourceType: 'Boxalarm::Department',
      resourceId,
    },
  );
}

export function createHandler(
  deps: Deps = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  const getHandler = createGetHandler(deps);
  const putHandler = createPutHandler(deps);
  return async (event: GuardEvent): Promise<APIGatewayProxyResultV2> => {
    if (event.routeKey === 'GET /api/v1/platform/retention') {
      return getHandler(event);
    }
    if (event.routeKey === 'PUT /api/v1/platform/retention') {
      return putHandler(event);
    }
    const traceId = extractTraceId(event);
    return problemResponse(404, 'Not found', `No route for ${event.routeKey}.`, traceId);
  };
}

export const handler = createHandler();
