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
import {
  deriveCertificationStatus,
  listCertificationsForMember,
} from '../certificationRepository.js';
import { createDynamoClient } from '../dynamoClient.js';

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

async function listCertificationsInner(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = event.pathParameters?.memberId;
  if (!memberId) {
    return badRequestProblem(traceId, [{ field: 'memberId', detail: 'is required' }]);
  }

  const deptId = toVerifiedDeptId(principal);
  const now = new Date();
  try {
    const client = createDynamoClient();
    const records = await listCertificationsForMember(client, process.env, {
      deptId,
      memberId,
      correlationId: traceId,
    });

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        records.map((record) => ({
          ...record,
          status: deriveCertificationStatus(record.status, record.expiryDate, now),
        })),
      ),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'certification.list.unhandled',
        service: 'training',
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        correlationId: traceId,
        memberId,
      }),
    );
    return serverErrorProblem(traceId);
  }
}

export const handler = withAuthorization(listCertificationsInner, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewCertifications',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => event.pathParameters?.memberId ?? '',
});
