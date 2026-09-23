import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  badRequestProblem,
  extractTraceId,
  notFoundProblem,
  serviceUnavailableProblem,
  withAuthorization,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { getDocumentClient, readInspectionsConfig } from '../dynamoClient.js';
import {
  buildAssetKey,
  createSignedAssetUrl,
  readAssetsConfig,
  type SignUrlFn,
} from '../assetsSigner.js';
import { emitInspectionMetric } from '../metrics.js';
import { ValidationError, toApiInspection } from '../inspectionRecord.js';
import { FieldCaptureValidationError, parseFieldCapturePayload } from './payload.js';
import {
  FieldCaptureDependencyError,
  FieldCaptureInspectionNotFoundError,
  FieldCaptureOccupancyNotFoundError,
  submitFieldCapture,
} from './repository.js';
import { logError, logInfo } from '../logger.js';

function parseBody(event: GuardEvent): unknown {
  if (!event.body) {
    return {};
  }
  try {
    return JSON.parse(event.body);
  } catch (error) {
    logError({
      event: 'fieldCapture.body.malformed',
      service: 'inspections-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      traceId: extractTraceId(event),
    });
    return undefined;
  }
}

function bodyStringField(body: unknown, field: string): string | undefined {
  const value =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)[field]
      : undefined;
  return typeof value === 'string' ? value : undefined;
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function signPhotoUploads(
  keys: readonly string[],
  assetsConfig: Awaited<ReturnType<typeof readAssetsConfig>>,
  signer: SignUrlFn | undefined,
): { filename: string; uploadUrl: string }[] {
  return keys.map((key) => ({
    filename: key.slice(key.lastIndexOf('/') + 1),
    uploadUrl: createSignedAssetUrl(assetsConfig, key, signer),
  }));
}

export function createFieldCaptureHandler(
  doc?: DynamoDBDocumentClient,
  signer?: SignUrlFn,
  authzClient?: VerifiedPermissionsClient,
  secretsClient?: SecretsManagerClient,
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization<APIGatewayProxyResultV2>(
    async (event, principal) => {
      const traceId = extractTraceId(event);
      const deptId = toVerifiedDeptId(principal);

      let payload;
      try {
        payload = parseFieldCapturePayload(parseBody(event));
      } catch (error) {
        if (error instanceof FieldCaptureValidationError || error instanceof ValidationError) {
          return badRequestProblem(traceId, error.message);
        }
        throw error;
      }

      const { tableName } = readInspectionsConfig(process.env);
      const client = getDocumentClient(doc);
      const { occupancyId, inspectionId, idempotencyKey, photoFilenames, violations, conductedAt } =
        payload;

      let assetsConfig;
      try {
        assetsConfig = await readAssetsConfig(process.env, secretsClient);
      } catch (error) {
        logError({
          event: 'fieldCapture.assetsConfig.failed',
          service: 'inspections-service',
          reason: error instanceof Error ? error.constructor.name : 'UnknownError',
          deptId,
          occupancyId,
          inspectionId,
          traceId,
        });
        emitInspectionMetric('FieldCaptureFailed');
        return serviceUnavailableProblem(traceId);
      }

      const photoUploads = photoFilenames.map((filename) => {
        const key = buildAssetKey(deptId, 'INSPECTION_RECORD', inspectionId, filename);
        return { filename, key, uploadUrl: createSignedAssetUrl(assetsConfig, key, signer) };
      });

      let result;
      try {
        result = await submitFieldCapture(client, tableName, {
          deptId,
          occupancyId,
          inspectionId,
          idempotencyKey,
          violations,
          photoS3Keys: photoUploads.map((upload) => upload.key),
          conductedBy: principal.sub,
          submittedAt: new Date().toISOString(),
          ...(conductedAt !== undefined && { conductedAt }),
        });
      } catch (error) {
        if (error instanceof FieldCaptureOccupancyNotFoundError) {
          logError({
            event: 'fieldCapture.occupancyNotFound',
            service: 'inspections-service',
            reason: error.name,
            deptId,
            occupancyId,
            inspectionId,
            traceId,
          });
          emitInspectionMetric('FieldCaptureFailed');
          return notFoundProblem(traceId, error.message);
        }
        if (error instanceof FieldCaptureInspectionNotFoundError) {
          logError({
            event: 'fieldCapture.inspectionNotFound',
            service: 'inspections-service',
            reason: error.name,
            deptId,
            occupancyId,
            inspectionId,
            traceId,
          });
          emitInspectionMetric('FieldCaptureFailed');
          return notFoundProblem(traceId, error.message);
        }
        if (error instanceof FieldCaptureDependencyError) {
          logError({
            event: 'fieldCapture.dependencyUnavailable',
            service: 'inspections-service',
            reason: error.reason,
            deptId,
            occupancyId,
            inspectionId,
            traceId,
          });
          emitInspectionMetric('FieldCaptureFailed');
          return serviceUnavailableProblem(traceId);
        }
        throw error;
      }

      if (result.outcome === 'duplicate') {
        logInfo({
          event: 'fieldCapture.duplicate',
          service: 'inspections-service',
          deptId,
          occupancyId,
          inspectionId,
          traceId,
        });
        emitInspectionMetric('FieldCaptureDuplicate');
        return jsonResponse(200, {
          idempotencyOutcome: 'duplicate',
          inspection: toApiInspection(result.item),
          photoUploadUrls: signPhotoUploads(result.item.photoS3Keys ?? [], assetsConfig, signer),
        });
      }

      logInfo({
        event: 'fieldCapture.submitted',
        service: 'inspections-service',
        deptId,
        occupancyId,
        inspectionId,
        traceId,
      });
      emitInspectionMetric('FieldCaptureSubmitted');
      return jsonResponse(201, {
        idempotencyOutcome: 'created',
        inspection: toApiInspection(result.item),
        photoUploadUrls: photoUploads.map(({ filename, uploadUrl }) => ({ filename, uploadUrl })),
      });
    },
    {
      actionType: 'Boxalarm::Action',
      actionId: 'SubmitFieldCapture',
      resourceType: 'Boxalarm::Inspection',
      resourceId: (event) => bodyStringField(parseBody(event), 'occupancyId') ?? 'unknown',
      ...(authzClient ? { client: authzClient } : {}),
    },
  );
}

export const handler = createFieldCaptureHandler();
