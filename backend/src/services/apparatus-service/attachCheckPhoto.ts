import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  badRequestProblem,
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { requireUploadContentType } from '../inspections-service/assetsSigner.js';
import { resolveApparatusIdByUnitId } from './checklistResolution.js';
import {
  ALLOWED_PHOTO_EXTENSIONS,
  SAFE_FILENAME,
  UPLOAD_URL_EXPIRY_SECONDS,
  isSafeFilename,
  presignPut,
  readDefectPhotoUploadConfig,
  type PresignPutFn,
} from './defectPhotoUpload.js';
import { createDynamoClient, readApparatusServiceConfig } from './dynamoClient.js';
import { logError } from './logger.js';
import {
  apparatusNotFoundProblem,
  validationProblem,
  type ValidationFieldError,
} from './problemDetails.js';

/**
 * POST /api/v1/apparatus/{unitId}/checks/{checkKey}/photos — a photo taken on a truck-check item
 * (passed or not), attached to the run by the run's idempotencyKey. Returns a presigned S3 PUT
 * signed with the photo's content type, under {deptId}/check/ - the only prefix this route's role
 * may write. The phone's offline outbox sends one of these per photo, independently of the run
 * POST, so the order they drain in doesn't matter.
 *
 * Idempotent on (checkKey, itemCode): a replay returns the stored key with a freshly signed
 * link, which is how the outbox recovers a link that expired before the photo went up.
 */

// A client idempotency key or check-sheet item code: becomes a sort-key and S3-key segment.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * A replay re-signs the stored photo's upload link only for the member who took it, or the
 * apparatus-officer tier (Cedar APPARATUS_OFFICER_GROUPS), and only this long after it was
 * recorded - long enough for a phone to sit offline for days, short enough that a check's
 * evidence photo can't be overwritten later by anyone who learns its key.
 */
export const RESIGN_WINDOW_SECONDS = 7 * 24 * 3600;
const RESIGN_OFFICER_GROUPS = new Set(['APPARATUS', 'OFFICER', 'CHIEF', 'ADMIN']);

function mayResign(
  principal: CedarPrincipalContext,
  row: Record<string, unknown>,
  now: number,
): boolean {
  const createdAt = typeof row.createdAt === 'number' ? row.createdAt : 0;
  if (now - createdAt > RESIGN_WINDOW_SECONDS) return false;
  if (row.uploadedBy === principal.sub) return true;
  return principal['cognito:groups']
    .split(/[\s,]+/)
    .some((group) => RESIGN_OFFICER_GROUPS.has(group.toUpperCase()));
}

/** No ".." anywhere: signed() refuses a stored key containing one. */
function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && !value.includes('..');
}

interface AttachCheckPhotoDeps {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly now: () => number;
  readonly presign: PresignPutFn;
}

interface ValidatedBody {
  /** The item code as sent, stored on the row. */
  readonly itemCode: string;
  /** The code as a key segment: itemCode itself when it is safe, else a sanitized form. */
  readonly itemSegment: string;
  readonly itemCodeIgnored: boolean;
  readonly filename: string;
}

/**
 * A safe key segment for a malformed item code (a sheet authored before codes were checked):
 * the photo is evidence and is kept, under a sanitized segment, rather than refused.
 */
function toSafeSegment(code: string): string {
  const cleaned = code
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/\.{2,}/g, '_')
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'ITEM';
}

function validateBody(
  body: Record<string, unknown>,
):
  | { readonly ok: true; readonly value: ValidatedBody }
  | { readonly ok: false; readonly errors: readonly ValidationFieldError[] } {
  const errors: ValidationFieldError[] = [];
  const itemCode = body.itemCode;
  if (typeof itemCode !== 'string' || itemCode.trim().length === 0 || itemCode.length > 256) {
    errors.push({
      field: 'itemCode',
      message: 'is required and must be a string of 1-256 characters',
    });
  }
  const photo = body.photo as { filename?: unknown } | undefined;
  const filename = typeof photo === 'object' && photo !== null ? photo.filename : undefined;
  if (typeof filename !== 'string' || !isSafeFilename(filename)) {
    errors.push({
      field: 'photo.filename',
      message:
        `is required and must match ${SAFE_FILENAME} with an allowed image extension ` +
        `(${[...ALLOWED_PHOTO_EXTENSIONS].join(', ')})`,
    });
  }
  return errors.length > 0
    ? { ok: false, errors }
    : {
        ok: true,
        value: {
          itemCode: itemCode as string,
          itemSegment: isSafeSegment(itemCode as string)
            ? (itemCode as string)
            : toSafeSegment(itemCode as string),
          itemCodeIgnored: !isSafeSegment(itemCode as string),
          filename: filename as string,
        },
      };
}

function photoSk(checkKey: string, itemCode: string): string {
  return `CHECK_PHOTO#${checkKey}#${itemCode}`;
}

async function signed(
  deps: AttachCheckPhotoDeps,
  deptId: VerifiedDeptId,
  photoS3Key: string,
): Promise<{ uploadUrl: string; uploadContentType: string }> {
  if (!photoS3Key.startsWith(`${deptId}/check/`) || photoS3Key.includes('..')) {
    throw new TypeError(`stored photo key is outside ${deptId}/check/: ${photoS3Key}`);
  }
  const { bucketName } = await readDefectPhotoUploadConfig(process.env);
  const contentType = requireUploadContentType(photoS3Key);
  return {
    uploadUrl: await deps.presign(bucketName, photoS3Key, UPLOAD_URL_EXPIRY_SECONDS, contentType),
    uploadContentType: contentType,
  };
}

function problemJson(status: number, detail: string, traceId: string): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: 'https://boxalarm.dev/problems/check-photo-exists',
      title: 'Conflict',
      status,
      detail,
      traceId,
    }),
  };
}

function jsonResponse(
  statusCode: 200 | 201,
  body: Record<string, unknown>,
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function attachCheckPhoto(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: AttachCheckPhotoDeps,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const unitId = event.pathParameters?.unitId;
  const checkKey = event.pathParameters?.checkKey;
  if (!unitId || unitId.trim().length === 0) {
    return badRequestProblem(traceId, 'unitId path parameter is required');
  }
  if (!checkKey || !isSafeSegment(checkKey)) {
    return badRequestProblem(traceId, `checkKey path parameter must match ${SAFE_SEGMENT}`);
  }
  const deptId = toVerifiedDeptId(principal);

  let rawBody: Record<string, unknown>;
  try {
    rawBody = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
  } catch {
    return validationProblem(traceId, [{ field: 'body', message: 'must be valid JSON' }]);
  }
  const validation = validateBody(rawBody);
  if (!validation.ok) {
    return validationProblem(traceId, validation.errors);
  }
  const { itemCode, itemSegment, itemCodeIgnored, filename } = validation.value;
  if (itemCodeIgnored) {
    logError({
      event: 'apparatus.checkPhoto.itemCodeSanitized',
      service: 'apparatus-service',
      correlationId: traceId,
      deptId,
      unitId,
      itemSegment,
    });
    emitOutcomeMetric('Boxalarm/apparatus-service', 'CheckPhotoItemCodeSanitized');
  }

  let operation = 'resolveApparatus';
  try {
    const apparatusId = await resolveApparatusIdByUnitId(
      deps.client,
      deps.tableName,
      deptId,
      unitId,
    );
    if (!apparatusId) {
      emitOutcomeMetric('Boxalarm/apparatus-service', 'AttachCheckPhotoNotFound');
      return apparatusNotFoundProblem(traceId);
    }

    const pk = buildDeptScopedPk(deptId, 'APPARATUS', apparatusId);
    const sk = photoSk(checkKey, itemSegment);
    const photoS3Key = `${deptId}/check/${apparatusId}/${checkKey}/${itemSegment}/${filename}`;
    // Fails before anything is written if the content type can't be signed.
    requireUploadContentType(filename);
    const ts = deps.now();
    const date = new Date(ts * 1000).toISOString().slice(0, 10);
    const mutatedEntityId = `${apparatusId}-${checkKey}-${itemSegment}`;

    operation = 'putCheckPhoto';
    try {
      await deps.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: deps.tableName,
                Item: {
                  pk,
                  sk,
                  entityType: 'CHECK_PHOTO',
                  apparatusId,
                  unitId,
                  checkKey,
                  itemCode,
                  photoS3Key,
                  uploadedBy: principal.sub,
                  createdAt: ts,
                },
                ConditionExpression: 'attribute_not_exists(sk)',
              },
            },
            {
              Put: {
                TableName: deps.tableName,
                Item: {
                  pk: buildDeptScopedPk(deptId, 'AUDIT', date),
                  sk: `${ts}#CHECK_PHOTO#${mutatedEntityId}#${principal.sub}`,
                  entityType: 'AUDIT_LOG_ENTRY',
                  mutatedEntityType: 'CHECK_PHOTO',
                  mutatedEntityId,
                  action: 'CREATE',
                  actorId: principal.sub,
                  ts,
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      const replay =
        error instanceof TransactionCanceledException &&
        error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
      if (!replay) throw error;
      operation = 'resignReplay';
      const existing = await deps.client.send(
        new GetCommand({ TableName: deps.tableName, Key: { pk, sk }, ConsistentRead: true }),
      );
      const storedKey: unknown = existing.Item?.photoS3Key;
      if (typeof storedKey !== 'string') {
        throw new Error('Check photo conditional write failed but the row could not be read', {
          cause: error,
        });
      }
      if (!mayResign(principal, existing.Item as Record<string, unknown>, deps.now())) {
        emitOutcomeMetric('Boxalarm/apparatus-service', 'AttachCheckPhotoResignRefused');
        return problemJson(
          409,
          'This item already has a photo on that check, and its upload link can no longer be renewed from here.',
          traceId,
        );
      }
      emitOutcomeMetric('Boxalarm/apparatus-service', 'AttachCheckPhotoReplayed');
      return jsonResponse(200, {
        checkKey,
        itemCode,
        photoS3Key: storedKey,
        ...(await signed(deps, deptId, storedKey)),
      });
    }

    operation = 'presign';
    const upload = await signed(deps, deptId, photoS3Key);
    emitOutcomeMetric('Boxalarm/apparatus-service', 'AttachCheckPhotoCreated');
    return jsonResponse(201, { checkKey, itemCode, photoS3Key, ...upload });
  } catch (error) {
    logError({
      event: 'apparatus.checkPhoto.error',
      service: 'apparatus-service',
      operation,
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      correlationId: traceId,
      deptId,
      unitId,
    });
    emitOutcomeMetric('Boxalarm/apparatus-service', 'AttachCheckPhotoFailed');
    return serviceUnavailableProblem(traceId);
  }
}

interface AttachCheckPhotoOverrides {
  readonly client?: DynamoDBDocumentClient;
  readonly tableName?: string;
  readonly now?: () => number;
  readonly presign?: PresignPutFn;
  readonly authzClient?: VerifiedPermissionsClient;
}

export function createAttachCheckPhotoHandler(
  overrides: AttachCheckPhotoOverrides = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    (event, principal) =>
      attachCheckPhoto(event, principal, {
        client: overrides.client ?? createDynamoClient(process.env),
        tableName: overrides.tableName ?? readApparatusServiceConfig(process.env).tableName,
        now: overrides.now ?? (() => Math.floor(Date.now() / 1000)),
        presign: overrides.presign ?? presignPut,
      }),
    {
      actionType: 'Boxalarm::Action',
      actionId: 'AttachCheckPhoto',
      resourceType: 'Boxalarm::Apparatus',
      resourceId: (event) => event.pathParameters?.unitId ?? '',
      ...(overrides.authzClient !== undefined ? { client: overrides.authzClient } : {}),
    },
  );
}

export const handler = createAttachCheckPhotoHandler();
