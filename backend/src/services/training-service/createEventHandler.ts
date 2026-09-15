import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  createDocumentClient,
  emitTrainingMetric,
  extractTraceId,
  logError,
  logInfo,
  readTrainingConfig,
} from './client.js';
import { createTrainingEvent, type TrainingEvent } from './repository.js';
import { badRequestProblem } from './problemDetails.js';

interface CreateEventBody {
  readonly title?: unknown;
  readonly category?: unknown;
  readonly startAt?: unknown;
  readonly endAt?: unknown;
}

function parseBody(event: GuardEvent): CreateEventBody | undefined {
  if (!event.body) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(event.body);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isValid(body: CreateEventBody | undefined): body is Required<CreateEventBody> & {
  title: string;
  category: string;
  startAt: number;
  endAt: number;
} {
  return (
    !!body &&
    typeof body.title === 'string' &&
    body.title.length > 0 &&
    typeof body.category === 'string' &&
    body.category.length > 0 &&
    typeof body.startAt === 'number' &&
    Number.isFinite(body.startAt) &&
    typeof body.endAt === 'number' &&
    Number.isFinite(body.endAt) &&
    body.endAt > body.startAt
  );
}

async function inner(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const body = parseBody(event);
  if (!isValid(body)) {
    return badRequestProblem(
      traceId,
      'title, category, startAt and endAt are required, and endAt must be after startAt.',
    );
  }

  let created: TrainingEvent;
  try {
    const deptId = toVerifiedDeptId(principal);
    const config = readTrainingConfig(process.env);
    const client = createDocumentClient(process.env);
    created = await createTrainingEvent(client, config, deptId, {
      title: body.title,
      category: body.category,
      startAt: body.startAt,
      endAt: body.endAt,
    });
  } catch (error) {
    logError('training.event.create_failed', error, { deptId: principal.deptId, traceId });
    emitTrainingMetric('TrainingEventCreateFailed');
    return serviceUnavailableProblem(traceId);
  }

  logInfo('training.event.created', {
    traceId,
    deptId: principal.deptId,
    eventId: created.eventId,
  });
  emitTrainingMetric('TrainingEventCreated');

  return {
    statusCode: 201,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(created),
  };
}

export const handler = withAuthorization(inner, {
  actionType: 'Boxalarm::Action',
  actionId: 'CreateTrainingEvent',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
