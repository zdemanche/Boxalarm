import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { forbiddenProblem, serviceUnavailableProblem, type GuardEvent } from '@boxalarm/authz';
import {
  createDocumentClient,
  extractTraceId,
  logDenied,
  logError,
  readTrainingConfig,
  resolveTrainingPrincipal,
} from './client.js';
import { listMemberAttendanceEventIds, listTrainingEvents } from './repository.js';

export const handler = async (event: GuardEvent): Promise<APIGatewayProxyResultV2> => {
  const traceId = extractTraceId(event);
  const principal = resolveTrainingPrincipal(event);
  if (!principal) {
    logDenied('training.events.list.denied', 'MissingOrInvalidPrincipal', traceId);
    return forbiddenProblem(traceId);
  }

  try {
    const config = readTrainingConfig(process.env);
    const client = createDocumentClient(process.env);
    const [events, signedUpEventIds] = await Promise.all([
      listTrainingEvents(client, config, principal.deptId),
      listMemberAttendanceEventIds(client, config, principal.sub),
    ]);

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        events.map((trainingEvent) => ({
          ...trainingEvent,
          signedUp: signedUpEventIds.has(trainingEvent.eventId),
        })),
      ),
    };
  } catch (error) {
    logError('training.events.list.failed', error, { deptId: principal.deptId, traceId });
    return serviceUnavailableProblem(traceId);
  }
};
