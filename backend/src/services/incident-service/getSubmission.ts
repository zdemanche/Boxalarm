import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { withAuthorization, type CedarPrincipalContext, type GuardEvent } from '@boxalarm/authz';
import { assertNoDelimiter, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitIncidentMetric, problemResponse, resolveTraceId } from './authContext.js';
import { getSubmissionRepository } from './submissionRepository.js';
import { getDocumentClient, getTableName } from './repository.js';
import { querySubmissionLedger } from './reviewRepository.js';
import { loadReportContext } from './reportContext.js';
import { buildNerisIncidentPayload, payloadHash } from './neris/payload.js';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';

/**
 * Edited since NERIS last accepted it: the payload the report would send now hashes
 * differently from the one NERIS accepted. Any content edit counts — unit times, riding
 * staffing and modules included — and a lock, unlock or failed send does not (review M5).
 */
async function editedSinceAccepted(
  deptId: VerifiedDeptId,
  incidentId: string,
  lastPayloadHash: string | undefined,
): Promise<boolean> {
  if (!lastPayloadHash) return false;
  const context = await loadReportContext(deptId, incidentId);
  if (!context?.nerisApi || !context.settings.departmentNerisId) return false;
  const current = buildNerisIncidentPayload({
    incident: context.incident,
    units: context.units,
    departmentNerisId: context.settings.departmentNerisId,
    unitNerisIds: context.settings.unitNerisIds,
    schema: context.nerisApi,
  });
  return payloadHash(current) !== lastPayloadHash;
}

async function inner(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);
  const deptId = toVerifiedDeptId(principal);

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
      error instanceof Error ? error.message : 'invalid incidentId',
      traceId,
    );
  }

  try {
    const repository = getSubmissionRepository(process.env);
    const record = await repository.getSubmission(deptId, incidentId);
    if (!record) {
      return problemResponse(
        404,
        'Not Found',
        `No incident found with incidentId "${incidentId}".`,
        traceId,
      );
    }
    // The ledger (also served as GET .../submissions): every attempt with its NERIS id,
    // payload hash and NERIS's own errors, plus every NERIS status the poller has seen.
    const ledger = await querySubmissionLedger(
      getDocumentClient(),
      getTableName(process.env),
      deptId,
      incidentId,
    );
    const editedSinceSubmission = await editedSinceAccepted(
      deptId,
      incidentId,
      record.lastPayloadHash,
    );
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        incidentId: record.incidentId,
        status: record.status,
        submissionStatus: record.submissionStatus ?? null,
        ...(record.submissionFailureReason !== undefined
          ? { submissionFailureReason: record.submissionFailureReason }
          : {}),
        nerisIncidentId: record.nerisIncidentId ?? null,
        nerisStatus: record.nerisStatus ?? null,
        nerisStatusAt: record.nerisStatusAt ?? null,
        lockedAt: record.lockedAt ?? null,
        lockedBy: record.lockedBy ?? null,
        payloadHash: record.lastPayloadHash ?? null,
        firstSubmittedAt: record.firstSubmittedAt ?? null,
        editedSinceSubmission,
        attempts: ledger.attempts,
        statusHistory: ledger.statusHistory,
      }),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'incident.submission.get.failed',
        correlationId: traceId,
        deptId,
        incidentId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitIncidentMetric('IncidentSubmissionReadFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'Unable to read NERIS submission status.',
      traceId,
    );
  }
}

/** Security-web MINOR 2: a declared Cedar action (NERIS officer tier), not a groups check. */
export const handler = withAuthorization(inner, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewIncidentSubmission',
  resourceType: 'Boxalarm::Incident',
  resourceId: (event) => event.pathParameters?.incidentId ?? '',
});
