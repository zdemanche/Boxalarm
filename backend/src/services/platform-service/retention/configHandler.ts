import { randomUUID } from 'node:crypto';
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
  Handler,
} from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../authorizer/handler.js';
import { assertChiefOrAdmin, ForbiddenError } from './authz.js';
import { getDynamoDocClient } from './awsClients.js';
import { getRetentionConfig, putRetentionConfig } from './configRepository.js';

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
): APIGatewayProxyStructuredResultV2 {
  const body: ProblemDetails = { type: 'about:blank', title, status, detail, traceId };
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify(body),
  };
}

function jsonResponse(status: number, payload: unknown): APIGatewayProxyStructuredResultV2 {
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

function readAuthorizerContext(
  event: APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>,
): AuthorizerContext | undefined {
  const context = event.requestContext.authorizer.lambda;
  if (
    !context ||
    typeof context.sub !== 'string' ||
    context.sub.length === 0 ||
    typeof context.deptId !== 'string' ||
    context.deptId.length === 0 ||
    typeof context['cognito:groups'] !== 'string'
  ) {
    return undefined;
  }
  return context;
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
): Promise<APIGatewayProxyStructuredResultV2> {
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
): Promise<APIGatewayProxyStructuredResultV2> {
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
    log('error', 'retention.config.put.failed', errorContext(error), traceId);
    return problemResponse(
      503,
      'Retention config unavailable',
      'Unable to store retention configuration.',
      traceId,
    );
  }
}

export function createHandler(
  deps: Deps = {},
): Handler<
  APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>,
  APIGatewayProxyStructuredResultV2
> {
  return async (event) => {
    const traceId = randomUUID();
    const context = readAuthorizerContext(event);
    if (!context) {
      log(
        'error',
        'retention.config.authorizerContext.invalid',
        { routeKey: event.routeKey },
        traceId,
      );
      return problemResponse(401, 'Unauthorized', 'A valid session is required.', traceId);
    }

    let deptId: VerifiedDeptId;
    try {
      deptId = toVerifiedDeptId(context);
      assertChiefOrAdmin(context['cognito:groups']);
    } catch (error) {
      if (error instanceof ForbiddenError) {
        return problemResponse(403, 'Forbidden', 'CHIEF or ADMIN role is required.', traceId);
      }
      log('error', 'retention.config.authz.failed', errorContext(error), traceId);
      return problemResponse(401, 'Unauthorized', 'A valid session is required.', traceId);
    }

    if (event.routeKey === 'GET /api/v1/platform/retention') {
      return handleGet(deptId, traceId, deps);
    }
    if (event.routeKey === 'PUT /api/v1/platform/retention') {
      return handlePut(deptId, context.sub, event.body, traceId, deps);
    }
    return problemResponse(404, 'Not found', `No route for ${event.routeKey}.`, traceId);
  };
}

export const handler = createHandler();
