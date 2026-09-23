import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { KMSClient } from '@aws-sdk/client-kms';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  extractTraceId,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
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

// Bounds the blast radius of a single privileged request: an unbounded candidates array
// drives a fully serial GetItem-per-candidate loop, risking excessive DynamoDB/KMS calls
// or a Lambda timeout mid-batch.
const MAX_CANDIDATES = 500;

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
  if (candidates.length > MAX_CANDIDATES) {
    return { error: `candidates must not exceed ${MAX_CANDIDATES} entries.` };
  }
  const parsed: DisposalCandidate[] = [];
  for (const entry of candidates) {
    if (typeof entry !== 'object' || entry === null) {
      return { error: 'each candidate must be an object.' };
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.pk !== 'string' || typeof record.sk !== 'string') {
      return {
        error: 'each candidate requires pk and sk (entityType/age/kms are read from DynamoDB).',
      };
    }
    parsed.push({
      // Computed keys: locator only — trusted fields are derived from GetItem in runDisposal.
      ['pk']: record.pk,
      ['sk']: record.sk,
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
): Promise<APIGatewayProxyResultV2> {
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
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    async (event: GuardEvent, principal: CedarPrincipalContext) => {
      const traceId = extractTraceId(event);
      const deptId = toVerifiedDeptId(principal);
      if (event.routeKey !== 'POST /api/v1/platform/retention/disposal') {
        return problemResponse(404, 'Not found', `No route for ${event.routeKey}.`, traceId);
      }
      return handlePost(deptId, principal.sub, event.body, traceId, deps);
    },
    {
      actionType: 'Boxalarm::Action',
      actionId: 'RunRecordsDisposal',
      resourceType: 'Boxalarm::Department',
      resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
    },
  );
}

export const handler = createHandler();
