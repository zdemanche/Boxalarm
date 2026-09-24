import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import { assertNoDelimiter } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../platform-service/authorizer/handler.js';
import {
  emitIncidentMetric,
  problemResponse,
  readAuthorizerContext,
  resolveTraceId,
} from './authContext.js';
import { getDocumentClient, getIncidentRepository, getTableName } from './repository.js';
import { queryIncidentSecondaries } from './secondaryRepository.js';

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<AuthorizerContext> = async (
  event,
) => {
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);

  let deptId, isAdmin, sub;
  try {
    ({ deptId, isAdmin, sub } = readAuthorizerContext(event));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'incident.get.denied',
        correlationId: traceId,
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    return problemResponse(
      401,
      'Unauthorized',
      'A valid department-scoped authorization context is required.',
      traceId,
    );
  }

  const incidentId = event.pathParameters?.incidentId;
  if (!incidentId) {
    return problemResponse(400, 'Bad Request', 'incidentId path parameter is required.', traceId);
  }
  try {
    assertNoDelimiter(incidentId, 'incidentId');
  } catch (error) {
    return problemResponse(
      400,
      'Bad Request',
      error instanceof Error ? error.message : 'incidentId path parameter is invalid.',
      traceId,
    );
  }

  try {
    const repository = getIncidentRepository(process.env);
    const incident = await repository.getIncident(deptId, incidentId);
    if (!incident) {
      return problemResponse(
        404,
        'Not Found',
        `No incident found with incidentId "${incidentId}".`,
        traceId,
      );
    }
    const client = getDocumentClient();
    const tableName = getTableName(process.env);
    const secondaries = await queryIncidentSecondaries(client, tableName, deptId, incidentId);
    // Narrower audience than the general incident read (fact sheet Data Ownership note):
    // chief/admin see every module, everyone else only a module naming them as affected.
    const secondaryModules = secondaries.filter(
      (secondary) => isAdmin || secondary.affectedMemberIds.includes(sub),
    );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...incident, secondaryModules }),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'incident.get.failed',
        correlationId: traceId,
        deptId,
        incidentId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitIncidentMetric('IncidentReadFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'Unable to read the incident record.',
      traceId,
    );
  }
};
