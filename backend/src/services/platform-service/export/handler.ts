import { randomUUID } from 'node:crypto';
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
  Handler,
} from 'aws-lambda';
import { GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AuthorizerContext } from '../authorizer/handler.js';
import { assertChiefOrAdmin, ForbiddenError } from './authz.js';
import { getDynamoDocClient, getLambdaClient, getS3Client } from './awsClients.js';

interface Deps {
  readonly docClient?: DynamoDBDocumentClient;
  readonly s3Client?: S3Client;
  readonly lambdaClient?: LambdaClient;
}

interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly traceId: string;
}

function problemResponse(
  status: number,
  title: string,
  detail: string,
  traceId: string,
): APIGatewayProxyStructuredResultV2 {
  const body: ProblemDetails = { type: 'about:blank', title, status, detail, traceId };
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify(body),
  };
}

function jsonResponse(status: number, payload: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function log(
  level: 'log' | 'error',
  event: string,
  fields: Record<string, unknown>,
  traceId: string,
): void {
  console[level](
    JSON.stringify({ service: 'platform-service', correlationId: traceId, event, ...fields }),
  );
}

function errorContext(error: unknown): { reason: string; message: string } {
  return {
    reason: error instanceof Error ? error.constructor.name : 'UnknownError',
    message: error instanceof Error ? error.message : String(error),
  };
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const name = 'name' in error ? (error as { name?: unknown }).name : undefined;
  const httpStatusCode =
    '$metadata' in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      : undefined;
  return name === 'NotFound' || name === 'NoSuchKey' || httpStatusCode === 404;
}

function emitMetric(name: 'ExportInvoked' | 'ExportWorkerInvokeFailed'): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/platform',
            Dimensions: [[]],
            Metrics: [{ Name: name, Unit: 'Count' }],
          },
        ],
      },
      [name]: 1,
    }),
  );
}

function readAuthorizerContext(
  event: APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>,
): AuthorizerContext | undefined {
  const context = event.requestContext.authorizer.lambda;
  if (
    !context ||
    typeof context.sub !== 'string' ||
    context.sub.length === 0 ||
    typeof context.deptId !== 'string' ||
    context.deptId.length === 0 ||
    typeof context['cognito:groups'] !== 'string'
  ) {
    return undefined;
  }
  return context;
}

function exportObjectKey(deptId: VerifiedDeptId, jobId: string, fileName: string): string {
  return `${deptId}/${jobId}/${fileName}`;
}

interface ExportManifest {
  readonly jobId: string;
  readonly deptId: string;
  readonly tables: readonly string[];
  readonly itemCounts: Record<string, number>;
  readonly completedAt: string;
}

async function markJobFailed(
  docClient: DynamoDBDocumentClient,
  deptId: VerifiedDeptId,
  jobId: string,
  traceId: string,
): Promise<void> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: process.env.PLATFORM_TABLE_NAME,
        Key: { pk: buildDeptScopedPk(deptId, 'EXPORT', jobId), sk: 'METADATA' },
        UpdateExpression: 'SET #status = :failed',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':failed': 'FAILED' },
      }),
    );
  } catch (error) {
    log('error', 'export.jobStatusUpdate.failed', { ...errorContext(error), jobId }, traceId);
  }
}

// boxalarm-infrastructure must provision: platform-service export-handler Lambda role
// with s3:GetObject/HeadObject on boxalarm-exports-staging/* and lambda:InvokeFunction
// on the export-worker function ARN; env var EXPORT_WORKER_FUNCTION_NAME; a CloudWatch
// alarm on Boxalarm/Platform ExportInvoked (undimensioned, Sum >= 1) notifying the chief.
async function handlePost(
  deptId: VerifiedDeptId,
  actorId: string,
  traceId: string,
  deps: Deps,
): Promise<APIGatewayProxyStructuredResultV2> {
  const docClient = getDynamoDocClient(deps.docClient);
  const jobId = randomUUID();
  const requestedAt = new Date();
  const ts = Math.floor(requestedAt.getTime() / 1000);
  const date = requestedAt.toISOString().slice(0, 10);

  try {
    await docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: process.env.PLATFORM_TABLE_NAME,
              Item: {
                pk: buildDeptScopedPk(deptId, 'EXPORT', jobId),
                sk: 'METADATA',
                entityType: 'EXPORT_JOB',
                jobId,
                deptId,
                status: 'PENDING',
                requestedBy: actorId,
                requestedAt: requestedAt.toISOString(),
              },
            },
          },
          {
            Put: {
              // TODO: E8-S5 — route this write through the shared outbox helper once it
              // lands, instead of a direct PutItem (architecture:2617 requires audit
              // writes be separated from the services whose mutations they record).
              TableName: process.env.PLATFORM_TABLE_NAME,
              Item: {
                pk: buildDeptScopedPk(deptId, 'AUDIT', date),
                sk: `${ts}#EXPORT_JOB#${jobId}#${actorId}`,
                entityType: 'AUDIT_LOG_ENTRY',
                mutatedEntityType: 'EXPORT_JOB',
                mutatedEntityId: jobId,
                action: 'CREATE',
                actorId,
                changedFields: {},
                ts,
                gsi3pk: buildDeptScopedPk(deptId, 'AUDIT', 'ENTITY', 'EXPORT_JOB', jobId),
                gsi3sk: ts,
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    log('error', 'export.transactWrite.failed', { ...errorContext(error), jobId }, traceId);
    return problemResponse(503, 'Export unavailable', 'Unable to accept the export job.', traceId);
  }

  emitMetric('ExportInvoked');

  try {
    const lambdaClient = getLambdaClient(deps.lambdaClient);
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: process.env.EXPORT_WORKER_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ jobId, deptId })),
      }),
    );
  } catch (error) {
    log('error', 'export.workerInvoke.failed', { ...errorContext(error), jobId }, traceId);
    await markJobFailed(docClient, deptId, jobId, traceId);
    emitMetric('ExportWorkerInvokeFailed');
  }

  return jsonResponse(202, { jobId });
}

async function handleGet(
  deptId: VerifiedDeptId,
  jobId: string | undefined,
  traceId: string,
  deps: Deps,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!jobId) {
    return problemResponse(404, 'Export job not found', 'jobId is required.', traceId);
  }

  try {
    const docClient = getDynamoDocClient(deps.docClient);
    const job = await docClient.send(
      new GetCommand({
        TableName: process.env.PLATFORM_TABLE_NAME,
        Key: { pk: buildDeptScopedPk(deptId, 'EXPORT', jobId), sk: 'METADATA' },
      }),
    );
    if (!job.Item) {
      return problemResponse(404, 'Export job not found', `No export job ${jobId}.`, traceId);
    }
    if (job.Item.status === 'FAILED') {
      return jsonResponse(200, { status: 'FAILED' });
    }

    const s3Client = getS3Client(deps.s3Client);
    const manifestKey = exportObjectKey(deptId, jobId, 'manifest.json');
    try {
      await s3Client.send(
        new HeadObjectCommand({ Bucket: process.env.EXPORT_BUCKET_NAME, Key: manifestKey }),
      );
    } catch (headError) {
      if (!isNotFoundError(headError)) {
        log('error', 'export.manifestHead.failed', errorContext(headError), traceId);
        return problemResponse(
          503,
          'Export unavailable',
          'Unable to check export status.',
          traceId,
        );
      }
      const failedKey = exportObjectKey(deptId, jobId, '_failed.json');
      try {
        await s3Client.send(
          new HeadObjectCommand({ Bucket: process.env.EXPORT_BUCKET_NAME, Key: failedKey }),
        );
        return jsonResponse(200, { status: 'FAILED' });
      } catch (sentinelError) {
        if (!isNotFoundError(sentinelError)) {
          log('error', 'export.failedSentinelHead.failed', errorContext(sentinelError), traceId);
          return problemResponse(
            503,
            'Export unavailable',
            'Unable to check export status.',
            traceId,
          );
        }
        return jsonResponse(200, { status: 'PENDING' });
      }
    }

    const manifestObject = await s3Client.send(
      new GetObjectCommand({ Bucket: process.env.EXPORT_BUCKET_NAME, Key: manifestKey }),
    );
    const manifestText = await manifestObject.Body?.transformToString();
    let manifest: ExportManifest;
    try {
      manifest = JSON.parse(manifestText ?? '{}') as ExportManifest;
    } catch (parseError) {
      log('error', 'export.manifestParse.failed', errorContext(parseError), traceId);
      return problemResponse(503, 'Export unavailable', 'Export manifest is malformed.', traceId);
    }
    if (!Array.isArray(manifest.tables)) {
      log('error', 'export.manifestShape.invalid', { jobId }, traceId);
      return problemResponse(503, 'Export unavailable', 'Export manifest is malformed.', traceId);
    }

    const files = await Promise.all(
      manifest.tables.map(async (table: string) => ({
        table,
        url: await getSignedUrl(
          s3Client,
          new GetObjectCommand({
            Bucket: process.env.EXPORT_BUCKET_NAME,
            Key: exportObjectKey(deptId, jobId, `${table}.ndjson`),
          }),
          { expiresIn: 600 },
        ),
      })),
    );

    return jsonResponse(200, { status: 'COMPLETE', files });
  } catch (error) {
    log('error', 'export.get.failed', { ...errorContext(error), jobId }, traceId);
    return problemResponse(503, 'Export unavailable', 'Unable to retrieve export status.', traceId);
  }
}

export function createHandler(
  deps: Deps = {},
): Handler<
  APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>,
  APIGatewayProxyStructuredResultV2
> {
  return async (event) => {
    const traceId = randomUUID();
    const context = readAuthorizerContext(event);
    if (!context) {
      log('error', 'export.authorizerContext.invalid', { routeKey: event.routeKey }, traceId);
      return problemResponse(401, 'Unauthorized', 'A valid session is required.', traceId);
    }

    let deptId: VerifiedDeptId;
    try {
      deptId = toVerifiedDeptId(context);
      assertChiefOrAdmin(context['cognito:groups']);
    } catch (error) {
      if (error instanceof ForbiddenError) {
        return problemResponse(403, 'Forbidden', 'CHIEF or ADMIN role is required.', traceId);
      }
      log('error', 'export.authz.failed', errorContext(error), traceId);
      return problemResponse(401, 'Unauthorized', 'A valid session is required.', traceId);
    }

    if (event.routeKey === 'POST /api/v1/platform/export') {
      return handlePost(deptId, context.sub, traceId, deps);
    }
    if (event.routeKey === 'GET /api/v1/platform/export/{jobId}') {
      return handleGet(deptId, event.pathParameters?.jobId, traceId, deps);
    }
    return problemResponse(404, 'Not found', `No route for ${event.routeKey}.`, traceId);
  };
}

export const handler = createHandler();
