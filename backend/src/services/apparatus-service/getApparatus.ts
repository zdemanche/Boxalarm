import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../platform-service/authorizer/handler.js';
import {
  emitApparatusMetric,
  getTraceId,
  problemResponse,
  readAuthorizerContext,
} from './authContext.js';
import { createSignedAssetUrl } from '../inspections-service/assetsSigner.js';
import { defectPhotoKeyPrefix } from './defectPhotoUpload.js';
import { getApparatusRepository } from './apparatusRepository.js';
import type { ApparatusDetail, OpenDefectSummary } from './apparatusRepository.js';

async function withDefectPhotoUrls(
  apparatus: ApparatusDetail,
  deptId: VerifiedDeptId,
  traceId: string,
): Promise<ApparatusDetail> {
  const bucketName = process.env.PLATFORM_ASSETS_BUCKET_NAME;
  if (!bucketName) {
    return apparatus;
  }
  const openDefects = await Promise.all(
    apparatus.openDefects.map(
      async (defect): Promise<OpenDefectSummary & { photoUrl?: string }> => {
        const key = defect.photoS3Key;
        if (!key?.startsWith(defectPhotoKeyPrefix(deptId, defect.defectId)) || key.includes('..')) {
          return defect;
        }
        try {
          return { ...defect, photoUrl: await createSignedAssetUrl({ bucketName }, key) };
        } catch (error) {
          console.error(
            JSON.stringify({
              event: 'apparatus.get.defectPhotoUrlFailed',
              correlationId: traceId,
              deptId,
              defectId: defect.defectId,
              message: error instanceof Error ? error.message : undefined,
            }),
          );
          return defect;
        }
      },
    ),
  );
  return { ...apparatus, openDefects };
}

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<AuthorizerContext> = async (
  event,
) => {
  const traceId = getTraceId(process.env);

  let deptId;
  try {
    ({ deptId } = readAuthorizerContext(event));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'apparatus.get.denied',
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

  const unitId = event.pathParameters?.unitId;
  if (!unitId) {
    return problemResponse(400, 'Bad Request', 'unitId path parameter is required.', traceId);
  }

  try {
    const repository = getApparatusRepository(process.env);
    const apparatus = await repository.getApparatusDetail(deptId, unitId);
    if (!apparatus) {
      return problemResponse(
        404,
        'Not Found',
        `No apparatus found with unitId "${unitId}".`,
        traceId,
      );
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await withDefectPhotoUrls(apparatus, deptId, traceId)),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'apparatus.get.failed',
        correlationId: traceId,
        deptId,
        unitId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitApparatusMetric('ApparatusReadFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'Unable to read the apparatus record.',
      traceId,
    );
  }
};
