import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  badRequestProblem,
  extractTraceId,
  notFoundProblem,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readApparatusServiceConfig } from './dynamoClient.js';
import {
  ApparatusNotFoundError,
  DefectAlreadyResolvedError,
  DefectNotFoundError,
  DefectRepositoryUnavailableError,
  resolveDefect,
} from './defectRepository.js';

/**
 * POST /api/v1/apparatus/{unitId}/defects/{defectId}/resolve — closes a defect with a
 * required note (review MAJOR-2: nothing resolved a defect, so the dashboard's open list only
 * ever grew). Officer tier (Cedar ResolveDefect). When the resolved defect was OUT_OF_SERVICE
 * severity and the unit is still out of service, the response says so
 * (`unitStillOutOfService`) and the UI warns — a warning, not a refusal; see
 * defectRepository.resolveDefect for why the coupling is not enforced.
 */

export const RESOLUTION_NOTE_MAX_LENGTH = 1000;

function logResolveError(error: unknown, correlationId: string): void {
  console.error(
    JSON.stringify({
      event: 'apparatus.defects.resolve_failed',
      service: 'apparatus-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      correlationId,
    }),
  );
}

function conflictProblem(traceId: string, detail: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 409,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: 'https://boxalarm.dev/problems/conflict',
      title: 'Conflict',
      status: 409,
      detail,
      traceId,
    }),
  };
}

function parseNote(rawBody: string | undefined): string | undefined {
  if (!rawBody) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return undefined;
  }
  const note = (parsed as { note?: unknown } | null)?.note;
  if (typeof note !== 'string') {
    return undefined;
  }
  const trimmed = note.trim();
  return trimmed.length > 0 && trimmed.length <= RESOLUTION_NOTE_MAX_LENGTH
    ? trimmed
    : undefined;
}

interface ResolveDefectDeps {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
}

async function resolve(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: ResolveDefectDeps,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const unitId = event.pathParameters?.unitId;
  const defectId = event.pathParameters?.defectId;
  const note = parseNote(event.body);
  if (!unitId || !defectId) {
    return badRequestProblem(traceId, 'unitId and defectId path parameters are required.');
  }
  if (!note) {
    return badRequestProblem(
      traceId,
      `A non-empty note (how it was fixed, at most ${RESOLUTION_NOTE_MAX_LENGTH} characters) is required.`,
    );
  }
  const deptId = toVerifiedDeptId(principal);
  try {
    const result = await resolveDefect(deps.client, deps.tableName, {
      deptId,
      unitId,
      defectId,
      note,
      resolvedBy: principal.sub,
    });
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        defectId,
        status: 'RESOLVED',
        resolvedAt: result.resolvedAt,
        severity: result.severity,
        unitStillOutOfService: result.unitStillOutOfService,
      }),
    };
  } catch (error) {
    if (error instanceof ApparatusNotFoundError || error instanceof DefectNotFoundError) {
      return notFoundProblem(traceId, error.message);
    }
    if (error instanceof DefectAlreadyResolvedError) {
      return conflictProblem(traceId, error.message);
    }
    logResolveError(error, traceId);
    if (error instanceof DefectRepositoryUnavailableError) {
      return serviceUnavailableProblem(traceId);
    }
    throw error;
  }
}

interface ResolveDefectOverrides {
  readonly client?: DynamoDBDocumentClient;
  readonly tableName?: string;
  readonly authzClient?: VerifiedPermissionsClient;
}

function resolveDeps(overrides: ResolveDefectOverrides): ResolveDefectDeps {
  return {
    client: overrides.client ?? createDynamoClient(process.env),
    tableName: overrides.tableName ?? readApparatusServiceConfig(process.env).tableName,
  };
}

export function createResolveDefectHandler(
  overrides: ResolveDefectOverrides = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    (event, principal) => resolve(event, principal, resolveDeps(overrides)),
    {
      actionType: 'Boxalarm::Action',
      actionId: 'ResolveDefect',
      resourceType: 'Boxalarm::Apparatus',
      resourceId: (event) => event.pathParameters?.unitId ?? '',
      ...(overrides.authzClient !== undefined ? { client: overrides.authzClient } : {}),
    },
  );
}

export const handler = createResolveDefectHandler();
