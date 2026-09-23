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
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import {
  createDocumentClient,
  emitTrainingMetric,
  extractBearerToken,
  extractTraceId,
  logDenied,
  logError,
  logInfo,
  readTrainingConfig,
  resolveTrainingPrincipal,
} from './client.js';
import {
  createSignupAttendance,
  DuplicateSignupError,
  getTrainingEvent,
  recordAttendanceHours,
  type AttendeeHoursInput,
  type TrainingEvent as TrainingEventRecord,
} from './repository.js';
import {
  badRequestProblem,
  duplicateSignupProblem,
  eventNotFoundProblem,
  signupAfterEventStartedProblem,
} from './problemDetails.js';

interface SignupBody {
  readonly attendees?: unknown;
}

function parseBody(event: GuardEvent): SignupBody | undefined {
  if (!event.body) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.body);
  } catch {
    return undefined;
  }
  return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
}

function parseAttendees(raw: unknown): readonly AttendeeHoursInput[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const attendees: AttendeeHoursInput[] = [];
  for (const entry of raw as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) {
      return undefined;
    }
    const { memberId, hours } = entry as { memberId?: unknown; hours?: unknown };
    if (
      typeof memberId !== 'string' ||
      memberId.length === 0 ||
      typeof hours !== 'number' ||
      !Number.isFinite(hours) ||
      hours < 0
    ) {
      return undefined;
    }
    attendees.push({ memberId, hours });
  }
  return attendees;
}

async function authorizeAttendanceRecording(
  event: GuardEvent,
  eventId: string,
  traceId: string,
  deptId: string,
): Promise<APIGatewayProxyResultV2 | undefined> {
  const token = extractBearerToken(event);
  if (!token) {
    logDenied('training.attendance.denied', 'MissingBearerToken', traceId, { deptId, eventId });
    return forbiddenProblem(traceId);
  }
  try {
    const client = createAuthzClient(process.env);
    const config = readAuthzConfig(process.env);
    const allowed = await isAuthorized(client, config, token, {
      actionType: 'Boxalarm::Action',
      actionId: 'RecordTrainingAttendance',
      resourceType: 'Boxalarm::TrainingEvent',
      resourceId: eventId,
    });
    if (!allowed) {
      logDenied('training.attendance.denied', 'CedarDeny', traceId, { deptId, eventId });
      return forbiddenProblem(traceId);
    }
    return undefined;
  } catch (error) {
    if (error instanceof AuthzUnavailableError) {
      logError('training.attendance.unavailable', error, {
        deptId,
        eventId,
        traceId,
        reason: error.reason,
      });
      return serviceUnavailableProblem(traceId);
    }
    throw error;
  }
}

async function recordAttendance(
  event: GuardEvent,
  trainingEvent: TrainingEventRecord,
  traceId: string,
  deptId: VerifiedDeptId,
  attendeesRaw: unknown,
): Promise<APIGatewayProxyResultV2> {
  const attendees = parseAttendees(attendeesRaw);
  if (!attendees) {
    return badRequestProblem(
      traceId,
      'attendees must be a non-empty array of { memberId: string, hours: a non-negative number }.',
    );
  }

  const denial = await authorizeAttendanceRecording(event, trainingEvent.eventId, traceId, deptId);
  if (denial) {
    return denial;
  }

  const config = readTrainingConfig(process.env);
  const client = createDocumentClient(process.env);
  try {
    await recordAttendanceHours(client, config, deptId, trainingEvent, attendees);
  } catch (error) {
    logError('training.attendance.record_failed', error, {
      deptId,
      eventId: trainingEvent.eventId,
      traceId,
    });
    emitTrainingMetric('TrainingAttendanceRecordFailed', 'Error');
    return serviceUnavailableProblem(traceId);
  }

  logInfo('training.attendance.recorded', {
    deptId,
    eventId: trainingEvent.eventId,
    attendeeCount: attendees.length,
    traceId,
  });
  emitTrainingMetric('TrainingAttendanceRecorded');
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventId: trainingEvent.eventId, attendeeCount: attendees.length }),
  };
}

async function recordSelfSignup(
  trainingEvent: TrainingEventRecord,
  traceId: string,
  deptId: VerifiedDeptId,
  memberId: string,
): Promise<APIGatewayProxyResultV2> {
  if (Date.now() >= trainingEvent.startAt) {
    emitTrainingMetric('TrainingSignupFailed', 'AfterEventStarted');
    return signupAfterEventStartedProblem(traceId);
  }

  const config = readTrainingConfig(process.env);
  const client = createDocumentClient(process.env);
  try {
    await createSignupAttendance(client, config, deptId, trainingEvent, memberId);
  } catch (error) {
    if (error instanceof DuplicateSignupError) {
      emitTrainingMetric('TrainingSignupFailed', 'DuplicateSignup');
      return duplicateSignupProblem(traceId);
    }
    logError('training.signup.failed', error, { deptId, eventId: trainingEvent.eventId, traceId });
    emitTrainingMetric('TrainingSignupFailed', 'Error');
    return serviceUnavailableProblem(traceId);
  }

  logInfo('training.signup.created', { deptId, eventId: trainingEvent.eventId, memberId, traceId });
  emitTrainingMetric('TrainingSignupSucceeded');
  return {
    statusCode: 201,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventId: trainingEvent.eventId, memberId }),
  };
}

export const handler = async (event: GuardEvent): Promise<APIGatewayProxyResultV2> => {
  const traceId = extractTraceId(event);
  const principal = resolveTrainingPrincipal(event);
  if (!principal) {
    logDenied('training.signup.denied', 'MissingOrInvalidPrincipal', traceId);
    return forbiddenProblem(traceId);
  }

  const eventId = event.pathParameters?.eventId;
  if (!eventId) {
    return eventNotFoundProblem(traceId);
  }

  const body = parseBody(event);
  if (body === undefined) {
    return badRequestProblem(traceId, 'Request body must be a JSON object.');
  }

  let trainingEvent: TrainingEventRecord | undefined;
  try {
    const config = readTrainingConfig(process.env);
    const client = createDocumentClient(process.env);
    trainingEvent = await getTrainingEvent(client, config, principal.deptId, eventId);
  } catch (error) {
    logError('training.signup.lookup_failed', error, {
      deptId: principal.deptId,
      eventId,
      traceId,
    });
    return serviceUnavailableProblem(traceId);
  }
  if (!trainingEvent) {
    return eventNotFoundProblem(traceId);
  }

  if (body.attendees !== undefined) {
    return recordAttendance(event, trainingEvent, traceId, principal.deptId, body.attendees);
  }
  return recordSelfSignup(trainingEvent, traceId, principal.deptId, principal.sub);
};
