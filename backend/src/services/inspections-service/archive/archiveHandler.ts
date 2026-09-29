import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { withAuthorization, type CedarPrincipalContext, type GuardEvent } from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { getDocumentClient, readInspectionsConfig } from '../dynamoClient.js';
import { problemResponse } from '../hydrant/httpProblem.js';
import { logError } from '../logger.js';
import {
  ArchiveTargetNotFoundError,
  archiveHydrant,
  archiveOccupancy,
  type ArchiveResult,
} from './archiveRepository.js';

const METRIC_NAMESPACE = 'Boxalarm/inspections';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface ArchiveTarget {
  readonly kind: 'occupancy' | 'hydrant';
  /** Path parameter carrying the id (the routes differ: {id} vs {hydrantId}). */
  readonly pathParameter: string;
  readonly actionId: 'ArchiveOccupancy' | 'ArchiveHydrant';
  readonly resourceType: 'Boxalarm::Occupancy' | 'Boxalarm::Hydrant';
  readonly archive: typeof archiveOccupancy;
}

const TARGETS = {
  occupancy: {
    kind: 'occupancy',
    pathParameter: 'id',
    actionId: 'ArchiveOccupancy',
    resourceType: 'Boxalarm::Occupancy',
    archive: archiveOccupancy,
  },
  hydrant: {
    kind: 'hydrant',
    pathParameter: 'hydrantId',
    actionId: 'ArchiveHydrant',
    resourceType: 'Boxalarm::Hydrant',
    archive: archiveHydrant,
  },
} as const satisfies Record<string, ArchiveTarget>;

function traceIdOf(event: GuardEvent): string {
  const segment = event.headers?.traceparent?.split('-')[1];
  return segment && segment.length > 0 ? segment : randomUUID();
}

/**
 * POST .../{id}/archive — CHIEF/ADMIN only (Cedar ArchiveOccupancy / ArchiveHydrant, a
 * destructive action gated by role alone). Idempotent: archiving an archived record is 200
 * with changed: false.
 */
export function createArchiveHandler(
  kind: keyof typeof TARGETS,
  deps: { docClient?: DynamoDBDocumentClient; authzClient?: VerifiedPermissionsClient } = {},
) {
  const target: ArchiveTarget = TARGETS[kind];
  const idOf = (event: GuardEvent) => event.pathParameters?.[target.pathParameter] ?? '';

  const inner = async (
    event: GuardEvent,
    principal: CedarPrincipalContext,
  ): Promise<APIGatewayProxyStructuredResultV2> => {
    const traceId = traceIdOf(event);
    const id = idOf(event);
    if (!ID_PATTERN.test(id)) {
      return problemResponse(400, `Invalid ${target.kind} archive`, 'id is invalid', traceId);
    }
    const deptId = toVerifiedDeptId(principal);
    let result: ArchiveResult;
    try {
      result = await target.archive(
        getDocumentClient(deps.docClient),
        readInspectionsConfig(process.env).tableName,
        deptId,
        id,
        principal.sub,
      );
    } catch (error) {
      const notFound = error instanceof ArchiveTargetNotFoundError;
      logError({
        event: `${target.kind}.archive.failed`,
        service: 'inspections-service',
        correlationId: traceId,
        deptId,
        id,
        reason: notFound ? 'NotFound' : error instanceof Error ? error.constructor.name : 'Unknown',
        message: error instanceof Error ? error.message : undefined,
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'ArchiveFailed', notFound ? 'NotFound' : 'Dependency');
      return notFound
        ? problemResponse(
            404,
            `${target.kind} not found`,
            `${target.kind} "${id}" was not found`,
            traceId,
          )
        : problemResponse(
            503,
            'Inspections service unavailable',
            `unable to archive ${target.kind}`,
            traceId,
          );
    }
    emitOutcomeMetric(METRIC_NAMESPACE, result.changed ? 'Archived' : 'ArchiveNoop', target.kind);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [`${target.kind}Id`]: id, archived: true, ...result }),
    };
  };

  return withAuthorization(inner, {
    actionType: 'Boxalarm::Action',
    actionId: target.actionId,
    resourceType: target.resourceType,
    resourceId: (event) => idOf(event) || 'unknown',
    ...(deps.authzClient ? { client: deps.authzClient } : {}),
  });
}
