import { randomUUID } from 'node:crypto';
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
  Handler,
} from 'aws-lambda';
import type { KMSClient } from '@aws-sdk/client-kms';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../authorizer/handler.js';
import { assertChiefOrAdmin, ForbiddenError } from './authz.js';
import { getDynamoDocClient, getKmsClient } from './awsClients.js';
import { type DisposalCandidate, runDisposal } from './disposal.js';

interface Deps {
  readonly docClient?: DynamoDBDocumentClient;
  readonly kmsClient?: KMSClient;
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

function parseCandidates(body: string | undefined): DisposalCandidate[] | { error: string } {
  let raw: unknown;
  try {
    raw = body ? JSON.parse(body) : {};
  } catch {
    return { error: 'Request body must be valid JSON.' };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { error: 'Request body must be a JSON object.' };
  }
  const candidates = (raw as Record<string, unknown>).candidates;
  if (candidates === undefined) {
    return [];
  }
  if (!Array.isArray(candidates)) {
    return { error: 'candidates must be an array.' };
  }
  const parsed: DisposalCandidate[] = [];
  for (const entry of candidates) {
    if (typeof entry !== 'object' || entry === null) {
      return { error: 'each candidate must be an object.' };
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.pk !== 'string' ||
      typeof record.sk !== 'string' ||
      typeof record.entityType !== 'string' ||
      typeof record.ageEpochSeconds !== 'number'
    ) {
      return {
        error: 'each candidate requires pk, sk, entityType, and ageEpochSeconds.',
      };
    }
    parsed.push({
      // Computed keys: candidate pk is caller-supplied stored key, not a newly authored write.
      ['pk']: record.pk,
      ['sk']: record.sk,
      entityType: record.entityType,
      ageEpochSeconds: record.ageEpochSeconds,
      ...(typeof record.kmsKeyId === 'string' ? { kmsKeyId: record.kmsKeyId } : {}),
    });
  }
  return parsed;
}

async function handlePost(
  deptId: VerifiedDeptId,
  actorId: string,
  body: string | undefined,
  traceId: string,
  deps: Deps,
): Promise<APIGatewayProxyStructuredResultV2> {
  const candidates = parseCandidates(body);
  if (!Array.isArray(candidates)) {
    return problemResponse(400, 'Bad Request', candidates.error, traceId);
  }

  try {
    const result = await runDisposal({
      docClient: getDynamoDocClient(deps.docClient),
      kmsClient: getKmsClient(deps.kmsClient),
      deptId,
      actorId,
      traceId,
      nowEpochSeconds: Math.floor(Date.now() / 1000),
      candidates,
    });
    return jsonResponse(200, result);
  } catch (error) {
    log('error', 'retention.disposal.failed', errorContext(error), traceId);
    return problemResponse(503, 'Disposal unavailable', 'Unable to run records disposal.', traceId);
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
        'retention.disposal.authorizerContext.invalid',
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
      log('error', 'retention.disposal.authz.failed', errorContext(error), traceId);
      return problemResponse(401, 'Unauthorized', 'A valid session is required.', traceId);
    }

    if (event.routeKey === 'POST /api/v1/platform/retention/disposal') {
      return handlePost(deptId, context.sub, event.body, traceId, deps);
    }
    return problemResponse(404, 'Not found', `No route for ${event.routeKey}.`, traceId);
  };
}

export const handler = createHandler();
