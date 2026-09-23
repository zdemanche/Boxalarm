import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  AuthzUnavailableError,
  createAuthzClient,
  forbiddenProblem,
  isAuthorized,
  readAuthzConfig,
  serviceUnavailableProblem,
  type GuardEvent,
} from '@boxalarm/authz';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import {
  createDocumentClient,
  extractBearerToken,
  extractTraceId,
  logDenied,
  logError,
  logInfo,
  readTrainingConfig,
  resolveTrainingPrincipal,
} from './client.js';
import {
  listEventAttendees,
  listMemberAttendanceInRange,
  listTrainingEventsInRange,
  type DateRange,
} from './repository.js';
import { aggregateMemberHoursByCategory, aggregateRosterHoursByCategory } from './hours.js';
import { badRequestProblem } from './problemDetails.js';

const ROSTER_ATTENDEE_QUERY_CONCURRENCY = 10;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += limit) {
    const chunk = items.slice(start, start + limit);
    results.push(...(await Promise.all(chunk.map(fn))));
  }
  return results;
}

const METRIC_NAME = 'TrainingHoursQueried';

function parseRange(
  qs: Record<string, string | undefined> | null | undefined,
): DateRange | undefined {
  if (!qs?.from || !qs?.to) {
    return undefined;
  }
  const from = Number(qs.from);
  const to = Number(qs.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    return undefined;
  }
  return { from, to };
}

async function authorizeHoursQuery(
  event: GuardEvent,
  traceId: string,
  deptId: string,
  memberId: string | undefined,
): Promise<APIGatewayProxyResultV2 | undefined> {
  const token = extractBearerToken(event);
  if (!token) {
    logDenied('training.hours.denied', 'MissingBearerToken', traceId, { deptId, memberId });
    return forbiddenProblem(traceId);
  }
  const action = memberId
    ? {
        actionType: 'Boxalarm::Action',
        actionId: 'ViewTrainingHours',
        resourceType: 'Boxalarm::Member',
        resourceId: memberId,
      }
    : {
        actionType: 'Boxalarm::Action',
        actionId: 'ViewRosterTrainingHours',
        resourceType: 'Boxalarm::Department',
        resourceId: deptId,
      };
  try {
    const client = createAuthzClient(process.env);
    const config = readAuthzConfig(process.env);
    const allowed = await isAuthorized(client, config, token, action);
    if (!allowed) {
      logDenied('training.hours.denied', 'CedarDeny', traceId, { deptId, memberId });
      return forbiddenProblem(traceId);
    }
    return undefined;
  } catch (error) {
    if (error instanceof AuthzUnavailableError) {
      logError('training.hours.unavailable', error, {
        deptId,
        memberId,
        traceId,
        reason: error.reason,
      });
      emitOutcomeMetric('Boxalarm/training', METRIC_NAME, 'Error');
      return serviceUnavailableProblem(traceId);
    }
    logError('training.hours.authorize_failed', error, { deptId, memberId, traceId });
    emitOutcomeMetric('Boxalarm/training', METRIC_NAME, 'Error');
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = async (event: GuardEvent): Promise<APIGatewayProxyResultV2> => {
  const traceId = extractTraceId(event);
  const principal = resolveTrainingPrincipal(event);
  if (!principal) {
    logDenied('training.hours.denied', 'MissingOrInvalidPrincipal', traceId);
    return forbiddenProblem(traceId);
  }

  const qs = event.queryStringParameters;
  const memberId = qs?.memberId;
  if (memberId !== undefined && memberId.length === 0) {
    return badRequestProblem(traceId, 'memberId must not be empty when provided.');
  }

  const range = parseRange(qs);
  if (!range) {
    return badRequestProblem(
      traceId,
      'from and to are required numeric epoch-millisecond query parameters with from <= to.',
    );
  }

  const denial = await authorizeHoursQuery(event, traceId, principal.deptId, memberId);
  if (denial) {
    return denial;
  }

  try {
    const config = readTrainingConfig(process.env);
    const client = createDocumentClient(process.env);

    if (memberId) {
      const records = await listMemberAttendanceInRange(
        client,
        config,
        principal.deptId,
        memberId,
        range,
      );
      const categories = aggregateMemberHoursByCategory(records);
      logInfo('training.hours.queried', { deptId: principal.deptId, memberId, traceId });
      emitOutcomeMetric('Boxalarm/training', METRIC_NAME);
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ memberId, from: range.from, to: range.to, categories }),
      };
    }

    const events = await listTrainingEventsInRange(client, config, principal.deptId, range);
    // ponytail: still one Query per matched event (P1/A4/V1-r1) -- bounded here to avoid an
    // unbounded DynamoDB burst, but the query *count* is unchanged. Eliminating it needs a
    // data-model decision (a new dept-scoped TRAINING_ATTENDANCE GSI, or a write-time rollup
    // item maintained by recordAttendanceHours) that architecture.md/plan.md don't make and
    // that crosses into boxalarm-infrastructure's ownership -- tracked as a follow-up, not
    // invented here.
    const attendeesByEvent = new Map(
      await mapWithConcurrency(
        events,
        ROSTER_ATTENDEE_QUERY_CONCURRENCY,
        async (trainingEvent) =>
          [
            trainingEvent.eventId,
            await listEventAttendees(client, config, principal.deptId, trainingEvent.eventId),
          ] as const,
      ),
    );
    const members = aggregateRosterHoursByCategory(events, attendeesByEvent);
    logInfo('training.hours.queried', { deptId: principal.deptId, traceId, roster: true });
    emitOutcomeMetric('Boxalarm/training', METRIC_NAME);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: range.from, to: range.to, members }),
    };
  } catch (error) {
    logError('training.hours.failed', error, { deptId: principal.deptId, memberId, traceId });
    emitOutcomeMetric('Boxalarm/training', METRIC_NAME, 'Error');
    return serviceUnavailableProblem(traceId);
  }
};
