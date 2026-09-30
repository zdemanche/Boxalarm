import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  AuthzUnavailableError,
  createAuthzClient,
  isAuthorized,
  readAuthzConfig,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { assertNoDelimiter } from '@boxalarm/dept-scope';
import {
  RequestValidationError,
  emitIncidentMetric,
  nowEpochSeconds,
  problemResponse,
  readIncidentWriteRequest,
  type IncidentEvent,
} from './authContext.js';
import {
  IncidentNotFoundError,
  getDocumentClient,
  getIncidentRepository,
  getTableName,
} from './repository.js';
import { IncidentLockedError, lockedProblem } from './lock.js';
import {
  SecondaryConflictError,
  getIncidentSecondary,
  putIncidentSecondary,
  type IncidentSecondary,
} from './secondaryRepository.js';
import { createSchemaVersionRepository } from './schemaVersion/repository.js';
import { getSecondarySchemaDocument } from './schemaVersion/s3Schema.js';
import { getS3Client } from '../platform-service/export/awsClients.js';
import {
  missingRequiredSecondaryFields,
  validateSecondaryFields,
} from './schemaVersion/validateEnum.js';

interface ParsedExposureInput {
  readonly secondaryType: string;
  readonly payload: Record<string, string>;
  readonly affectedMemberIds: readonly string[];
  /** The version the client last read; a mismatch is a 409, not a silent overwrite. */
  readonly expectedVersion?: number;
}

function parseInput(record: Record<string, unknown>): ParsedExposureInput {
  const secondaryType = record.secondaryType;
  if (typeof secondaryType !== 'string' || secondaryType.trim().length === 0) {
    throw new RequestValidationError('secondaryType is required and must be a non-empty string');
  }
  assertNoDelimiter(secondaryType, 'secondaryType');

  const payload = record.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new RequestValidationError('payload is required and must be a JSON object');
  }
  const payloadRecord = payload as Record<string, unknown>;
  const stringPayload: Record<string, string> = {};
  for (const [key, value] of Object.entries(payloadRecord)) {
    if (typeof value !== 'string') {
      throw new RequestValidationError(`payload field "${key}" must be a string`);
    }
    stringPayload[key] = value;
  }

  const affectedMemberIds = record.affectedMemberIds;
  if (
    !Array.isArray(affectedMemberIds) ||
    !affectedMemberIds.every((id) => typeof id === 'string')
  ) {
    throw new RequestValidationError(
      'affectedMemberIds is required and must be an array of strings',
    );
  }

  const expectedVersion = record.expectedVersion;
  if (
    expectedVersion !== undefined &&
    (typeof expectedVersion !== 'number' ||
      !Number.isInteger(expectedVersion) ||
      expectedVersion < 0)
  ) {
    throw new RequestValidationError('expectedVersion must be a non-negative integer when present');
  }

  return {
    secondaryType,
    payload: stringPayload,
    affectedMemberIds,
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  };
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/**
 * Who may write a responder-exposure module (review M3). Reads were already narrowed to the
 * affected member and chief/admin (getIncident.ts); writes were open to any member, so one
 * member could erase an exposure naming a colleague - cancer-presumption evidence.
 *  - Officer tier (OFFICER/CHIEF/ADMIN) records and corrects any module.
 *  - Any other member only a module that names them, and cannot change who it names: on a
 *    new module they may name only themselves; on an existing one the named set must stay
 *    exactly as it is.
 * Returns the 403 detail, or undefined when allowed.
 */
export function exposureWriteDenial(
  caller: { readonly sub: string; readonly isOfficerTier: boolean },
  existing: IncidentSecondary | undefined,
  nextAffectedMemberIds: readonly string[],
): string | undefined {
  if (caller.isOfficerTier) {
    return undefined;
  }
  if (!existing) {
    return nextAffectedMemberIds.length === 1 && nextAffectedMemberIds[0] === caller.sub
      ? undefined
      : 'A member may record only their own exposure; naming other members is an officer action.';
  }
  if (!existing.affectedMemberIds.includes(caller.sub)) {
    return 'Only an officer, or a member this exposure record names, may change it.';
  }
  if (!sameMembers(existing.affectedMemberIds, nextAffectedMemberIds)) {
    return 'Only an officer may change which members an exposure record names.';
  }
  return undefined;
}

/**
 * The officer override (security-web MINOR 2): recording or correcting a module that names
 * other members is Cedar RecordExposureForOthers (NERIS officer tier), decided on the caller's
 * own token - no longer a cognito:groups check.
 */
async function mayRecordForOthers(event: GuardEvent, incidentId: string): Promise<boolean> {
  const header = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return false;
  }
  return isAuthorized(createAuthzClient(process.env), readAuthzConfig(process.env), token, {
    actionType: 'Boxalarm::Action',
    actionId: 'RecordExposureForOthers',
    resourceType: 'Boxalarm::Incident',
    resourceId: incidentId,
  });
}

async function inner(
  guardEvent: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const event = guardEvent as unknown as IncidentEvent;
  const request = readIncidentWriteRequest(event, 'incident.exposures.denied', parseInput);
  if (!request.ok) {
    return request.response;
  }
  const { traceId, deptId, incidentId, input: input } = request;
  let caller: { readonly sub: string; readonly isOfficerTier: boolean };
  try {
    caller = {
      sub: principal.sub,
      isOfficerTier: await mayRecordForOthers(guardEvent, incidentId),
    };
  } catch (error) {
    if (error instanceof AuthzUnavailableError) {
      return problemResponse(
        503,
        'Service Unavailable',
        'The authorization service is temporarily unavailable.',
        traceId,
      );
    }
    throw error;
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
    if (incident.lockedAt !== undefined) {
      return lockedProblem(traceId);
    }

    const client = getDocumentClient();
    const tableName = getTableName(process.env);

    const existing = await getIncidentSecondary(
      client,
      tableName,
      deptId,
      incidentId,
      input.secondaryType,
    );
    const denial = exposureWriteDenial(caller, existing, input.affectedMemberIds);
    if (denial) {
      console.error(
        JSON.stringify({
          event: 'incident.exposures.denied',
          reason: 'NotOfficerOrAffectedMember',
          correlationId: traceId,
          deptId,
          incidentId,
          actorId: caller.sub,
        }),
      );
      emitIncidentMetric('IncidentSecondaryWriteDenied');
      return problemResponse(403, 'Forbidden', denial, traceId);
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== (existing?.version ?? 0)) {
      return problemResponse(
        409,
        'Conflict',
        'The exposure record changed since it was read; reload it and retry.',
        traceId,
        { currentVersion: existing?.version ?? 0 },
      );
    }

    const schemaVersionRepository = createSchemaVersionRepository(client, tableName);
    // Validate against the schema version this incident was authored under, not whatever
    // is newest: the scheduled refresh job can promote a new ACTIVE schema at any time, and
    // re-validating an older incident against it would apply enum/requiredFields rules it was
    // never authored under. Falls back to ACTIVE only when the pinned version can't be
    // resolved at all (e.g. the 'UNVALIDATED' sentinel createIncident.ts's dispatch-linked
    // path uses when no schema was ACTIVE yet at create time).
    const schema =
      (await schemaVersionRepository.getSchemaVersion(incident.nerisSchemaVersion)) ??
      (await schemaVersionRepository.getActiveSchemaVersion());
    if (!schema) {
      return problemResponse(
        503,
        'Service Unavailable',
        'No active NERIS schema version is published.',
        traceId,
      );
    }
    const secondarySchema = await getSecondarySchemaDocument(
      getS3Client(),
      process.env.NERIS_SCHEMA_BUCKET_NAME ?? '',
      schema.secondarySchemaS3Key,
    );

    const errors = validateSecondaryFields(secondarySchema, input.secondaryType, input.payload);
    if (errors.length > 0) {
      return problemResponse(
        400,
        'Bad Request',
        'One or more fields failed NERIS Secondary enumeration validation.',
        traceId,
        { errors },
      );
    }

    const missing = missingRequiredSecondaryFields(
      secondarySchema,
      input.secondaryType,
      input.payload,
    );
    const updatedAt = nowEpochSeconds();
    const version = await putIncidentSecondary(
      client,
      tableName,
      deptId,
      {
        incidentId,
        secondaryType: input.secondaryType,
        payload: input.payload,
        affectedMemberIds: input.affectedMemberIds,
        updatedAt,
      },
      traceId,
      { previous: existing, actorId: caller.sub },
    );

    emitIncidentMetric('IncidentSecondaryUpdated');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        incidentId,
        secondaryType: input.secondaryType,
        payload: input.payload,
        affectedMemberIds: input.affectedMemberIds,
        complete: missing.length === 0,
        updatedAt,
        version,
      }),
    };
  } catch (error) {
    if (error instanceof IncidentLockedError) {
      return lockedProblem(traceId);
    }
    if (error instanceof IncidentNotFoundError) {
      return problemResponse(404, 'Not Found', error.message, traceId);
    }
    if (error instanceof SecondaryConflictError) {
      return problemResponse(
        409,
        'Conflict',
        'The exposure record changed while this request was in flight; reload it and retry.',
        traceId,
      );
    }
    console.error(
      JSON.stringify({
        event: 'incident.exposures.failed',
        correlationId: traceId,
        deptId,
        incidentId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitIncidentMetric('IncidentSecondaryFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'Unable to record the Secondary-schema module.',
      traceId,
    );
  }
}

/**
 * Every role may write an exposure module (EditIncidentExposures): a member records their own.
 * Who it may name is then exposureWriteDenial's rule, with the officer override from Cedar.
 */
export const handler = withAuthorization(inner, {
  actionType: 'Boxalarm::Action',
  actionId: 'EditIncidentExposures',
  resourceType: 'Boxalarm::Incident',
  resourceId: (event) => event.pathParameters?.incidentId ?? '',
});
