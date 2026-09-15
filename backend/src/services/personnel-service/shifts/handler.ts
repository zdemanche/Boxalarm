import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { claimShiftPosition, ShiftPositionWriteError } from './claimShiftPosition.js';
import {
  createDynamoClient,
  readPersonnelTableConfig,
  type PersonnelTableConfig,
} from './dynamoClient.js';
import {
  badRequestProblem,
  conflictProblem,
  internalErrorProblem,
  notFoundProblem,
} from './problemDetails.js';
import { recalculateShiftStatus } from './recalculateShiftStatus.js';

function extractTraceId(event: GuardEvent): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function emitClaimMetric(outcome: 'Allowed' | 'Conflict' | 'Failed'): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/Personnel',
            Dimensions: [[]],
            Metrics: [{ Name: `Claim${outcome}`, Unit: 'Count' }],
          },
        ],
      },
      [`Claim${outcome}`]: 1,
    }),
  );
}

function readPositionCode(event: GuardEvent, traceId: string): string | APIGatewayProxyResultV2 {
  if (!event.body) {
    return badRequestProblem(traceId, 'Request body is required and must include positionCode');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.body) as unknown;
  } catch {
    return badRequestProblem(traceId, 'Request body must be valid JSON');
  }
  const positionCode = (parsed as { positionCode?: unknown } | null)?.positionCode;
  if (typeof positionCode !== 'string' || positionCode.trim().length === 0) {
    return badRequestProblem(traceId, 'positionCode is required and must be a non-empty string');
  }
  return positionCode;
}

export function createHandler(
  client?: DynamoDBDocumentClient,
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    async (
      event: GuardEvent,
      principal: CedarPrincipalContext,
    ): Promise<APIGatewayProxyResultV2> => {
      const traceId = extractTraceId(event);
      const shiftId = event.pathParameters?.shiftId;
      if (!shiftId) {
        return badRequestProblem(traceId, 'shiftId path parameter is required');
      }
      const positionCodeOrProblem = readPositionCode(event, traceId);
      if (typeof positionCodeOrProblem !== 'string') {
        return positionCodeOrProblem;
      }
      const positionCode = positionCodeOrProblem;

      if (shiftId.includes('#')) {
        return badRequestProblem(traceId, "shiftId must not contain '#'");
      }

      let deptId: VerifiedDeptId;
      let config: PersonnelTableConfig;
      try {
        deptId = toVerifiedDeptId(principal);
        config = readPersonnelTableConfig(process.env);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'personnel.shift_position.claim_failed',
            service: 'personnel-service',
            reason: error instanceof Error ? error.constructor.name : 'UnknownError',
            message: error instanceof Error ? error.message : undefined,
            correlationId: traceId,
            shiftId,
          }),
        );
        return internalErrorProblem(traceId);
      }
      const doc = createDynamoClient(process.env, client);

      let outcome;
      try {
        outcome = await claimShiftPosition(
          doc,
          config.tableName,
          deptId,
          shiftId,
          positionCode,
          principal.sub,
        );
      } catch (error) {
        const reason = error instanceof ShiftPositionWriteError ? error.reason : 'UnknownError';
        const originalError = error instanceof ShiftPositionWriteError ? error.cause : error;
        console.error(
          JSON.stringify({
            event: 'personnel.shift_position.claim_failed',
            service: 'personnel-service',
            reason,
            message: originalError instanceof Error ? originalError.message : undefined,
            correlationId: traceId,
            deptId,
            shiftId,
          }),
        );
        emitClaimMetric('Failed');
        return serviceUnavailableProblem(traceId);
      }

      if (outcome.kind === 'NOT_FOUND') {
        emitClaimMetric('Failed');
        return notFoundProblem(traceId);
      }
      if (outcome.kind === 'CONFLICT') {
        emitClaimMetric('Conflict');
        return conflictProblem(traceId);
      }

      if (outcome.kind === 'CLAIMED') {
        try {
          await recalculateShiftStatus(doc, config.tableName, deptId, shiftId);
        } catch (error) {
          console.error(
            JSON.stringify({
              event: 'personnel.duty_shift.status_recalc_failed',
              service: 'personnel-service',
              reason: error instanceof Error ? error.constructor.name : 'UnknownError',
              message: error instanceof Error ? error.message : undefined,
              correlationId: traceId,
              deptId,
              shiftId,
            }),
          );
          emitClaimMetric('Failed');
          return internalErrorProblem(traceId);
        }
      }

      emitClaimMetric('Allowed');
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shiftId,
          positionCode,
          claimedByMemberId: principal.sub,
          claimedAt: outcome.claimedAt,
        }),
      };
    },
    {
      actionType: 'PersonnelAction',
      actionId: 'ClaimShiftPosition',
      resourceType: 'Shift',
      resourceId: (event) => event.pathParameters?.shiftId ?? '',
    },
  );
}

export const handler = createHandler();
