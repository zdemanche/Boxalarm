import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  extractTraceId,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
  type ProblemResponse,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { CertNotFoundError, revokeCertification } from '../certificationRepository.js';
import { createDynamoClient, emitCertificationMetric } from '../dynamoClient.js';
import { logError } from '../logger.js';
import { certificationNotFoundProblem } from '../problemDetails.js';

function serverErrorProblem(traceId: string): ProblemResponse {
  return {
    statusCode: 500,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: 'https://boxalarm.dev/problems/internal-error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred.',
      traceId,
    }),
  };
}

async function revokeCertificationInner(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = event.pathParameters?.memberId;
  if (!memberId) {
    return badRequestProblem(traceId, [{ field: 'memberId', detail: 'is required' }]);
  }
  const certId = event.pathParameters?.certId;
  if (!certId) {
    return badRequestProblem(traceId, [{ field: 'certId', detail: 'is required' }]);
  }
  const deptId = toVerifiedDeptId(principal);

  try {
    const client = createDynamoClient();
    const record = await revokeCertification(client, process.env, {
      deptId,
      memberId,
      certId,
      actorId: principal.sub,
      correlationId: traceId,
      now: new Date(),
    });
    emitCertificationMetric('Revoked');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
    };
  } catch (error) {
    if (error instanceof CertNotFoundError) {
      logError({
        event: 'certification.revoke.notFound',
        service: 'training',
        reason: error.constructor.name,
        correlationId: traceId,
        memberId,
        certId,
      });
      return certificationNotFoundProblem(traceId);
    }
    emitCertificationMetric('Failed');
    logError({
      event: 'certification.revoke.unhandled',
      service: 'training',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      correlationId: traceId,
      memberId,
      certId,
    });
    return serverErrorProblem(traceId);
  }
}

export const handler = withAuthorization(revokeCertificationInner, {
  actionType: 'Training',
  actionId: 'RevokeCertification',
  resourceType: 'Member',
  resourceId: (event) => event.pathParameters?.memberId ?? '',
});
