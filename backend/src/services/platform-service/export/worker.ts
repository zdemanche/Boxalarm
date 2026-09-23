import type { Handler } from 'aws-lambda';
import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { getDynamoDocClient, getS3Client } from './awsClients.js';

export interface ExportWorkerEvent {
  readonly jobId: string;
  readonly deptId: string;
}

interface TableSpec {
  readonly name: 'alerting-service' | 'incident-service' | 'platform-service';
  readonly envVar: string;
}

const TABLES: readonly TableSpec[] = [
  { name: 'alerting-service', envVar: 'ALERTING_TABLE_NAME' },
  { name: 'incident-service', envVar: 'INCIDENT_TABLE_NAME' },
  { name: 'platform-service', envVar: 'PLATFORM_TABLE_NAME' },
];

const MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024;

interface Deps {
  readonly docClient?: DynamoDBDocumentClient;
  readonly s3Client?: S3Client;
}

function log(
  level: 'log' | 'error',
  event: string,
  fields: Record<string, unknown>,
  jobId: string,
): void {
  console[level](
    JSON.stringify({ service: 'platform-service', correlationId: jobId, event, ...fields }),
  );
}

function errorContext(error: unknown): { reason: string; message: string } {
  return {
    reason: error instanceof Error ? error.constructor.name : 'UnknownError',
    message: error instanceof Error ? error.message : String(error),
  };
}

function emitMetric(name: 'ExportCompleted' | 'ExportFailed'): void {
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

function exportObjectKey(deptId: string, jobId: string, fileName: string): string {
  return `${deptId}/${jobId}/${fileName}`;
}

async function writeFailedSentinel(
  s3Client: S3Client,
  deptId: string,
  jobId: string,
  table: string | undefined,
): Promise<void> {
  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.EXPORT_BUCKET_NAME,
        Key: exportObjectKey(deptId, jobId, '_failed.json'),
        Body: JSON.stringify({ jobId, deptId, table, failedAt: new Date().toISOString() }),
        ContentType: 'application/json',
      }),
    );
  } catch (error) {
    log('error', 'export.failedSentinel.failed', errorContext(error), jobId);
  }
}

class S3StreamWriter {
  private uploadId: string | undefined;
  private partNumber = 0;
  private readonly parts: { ETag: string; PartNumber: number }[] = [];
  private buffer = '';
  private hasWritten = false;

  constructor(
    private readonly s3Client: S3Client,
    private readonly bucket: string | undefined,
    private readonly key: string,
    private readonly contentType: string,
  ) {}

  async write(chunk: string): Promise<void> {
    this.hasWritten = true;
    this.buffer += chunk;
    if (this.buffer.length >= MULTIPART_PART_SIZE_BYTES) {
      await this.flushPart();
    }
  }

  private async ensureUpload(): Promise<void> {
    if (this.uploadId !== undefined) {
      return;
    }
    const created = await this.s3Client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.key,
        ContentType: this.contentType,
      }),
    );
    this.uploadId = created.UploadId;
  }

  private async flushPart(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }
    await this.ensureUpload();
    const uploadId = this.uploadId;
    if (uploadId === undefined) {
      throw new Error('multipart upload was not initialized');
    }
    this.partNumber += 1;
    const uploaded = await this.s3Client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: this.key,
        UploadId: uploadId,
        PartNumber: this.partNumber,
        Body: this.buffer,
      }),
    );
    this.parts.push({ ETag: uploaded.ETag ?? '', PartNumber: this.partNumber });
    this.buffer = '';
  }

  async finish(): Promise<void> {
    if (!this.hasWritten) {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key,
          Body: '',
          ContentType: this.contentType,
        }),
      );
      return;
    }
    await this.flushPart();
    const uploadId = this.uploadId;
    if (uploadId === undefined) {
      throw new Error('multipart upload was not initialized');
    }
    await this.s3Client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.key,
        UploadId: uploadId,
        MultipartUpload: { Parts: this.parts },
      }),
    );
  }

  async abort(): Promise<void> {
    if (this.uploadId !== undefined) {
      await this.s3Client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.key,
          UploadId: this.uploadId,
        }),
      );
    }
  }
}

async function scanTableStreaming(
  docClient: DynamoDBDocumentClient,
  tableName: string | undefined,
  deptId: string,
  onPage: (items: readonly Record<string, unknown>[]) => Promise<void>,
): Promise<number> {
  const verifiedDeptId = toVerifiedDeptId({ deptId });
  const deptPk = buildDeptScopedPk(verifiedDeptId);
  const deptPrefix = `${deptPk}#`;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let count = 0;
  do {
    const page = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'pk = :deptPk OR begins_with(pk, :deptPrefix)',
        ExpressionAttributeValues: { ':deptPk': deptPk, ':deptPrefix': deptPrefix },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const items = page.Items ?? [];
    count += items.length;
    await onPage(items);
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return count;
}

// boxalarm-infrastructure must provision: export-worker Lambda execution role with
// DynamoDB Query/Scan/GetItem (never write) on the alerting-service, incident-service,
// platform-service table ARNs; s3:PutObject scoped to boxalarm-exports-staging/*;
// env vars ALERTING_TABLE_NAME, INCIDENT_TABLE_NAME, PLATFORM_TABLE_NAME, EXPORT_BUCKET_NAME.
export function createHandler(deps: Deps = {}): Handler<ExportWorkerEvent, void> {
  return async ({ jobId, deptId }) => {
    const docClient = getDynamoDocClient(deps.docClient);
    const s3Client = getS3Client(deps.s3Client);
    const itemCounts: Record<string, number> = {};

    for (const table of TABLES) {
      const writer = new S3StreamWriter(
        s3Client,
        process.env.EXPORT_BUCKET_NAME,
        exportObjectKey(deptId, jobId, `${table.name}.ndjson`),
        'application/x-ndjson',
      );

      try {
        itemCounts[table.name] = await scanTableStreaming(
          docClient,
          process.env[table.envVar],
          deptId,
          async (items) => {
            for (const item of items) {
              await writer.write(`${JSON.stringify(item)}\n`);
            }
          },
        );
      } catch (error) {
        log('error', 'export.scan.failed', { ...errorContext(error), table: table.name }, jobId);
        await writer.abort().catch(() => undefined);
        await writeFailedSentinel(s3Client, deptId, jobId, table.name);
        emitMetric('ExportFailed');
        return;
      }

      try {
        await writer.finish();
      } catch (error) {
        log(
          'error',
          'export.tableUpload.failed',
          { ...errorContext(error), table: table.name },
          jobId,
        );
        await writer.abort().catch(() => undefined);
        await writeFailedSentinel(s3Client, deptId, jobId, table.name);
        emitMetric('ExportFailed');
        return;
      }
    }

    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: process.env.EXPORT_BUCKET_NAME,
          Key: exportObjectKey(deptId, jobId, 'manifest.json'),
          Body: JSON.stringify({
            jobId,
            deptId,
            tables: TABLES.map((table) => table.name),
            itemCounts,
            completedAt: new Date().toISOString(),
          }),
          ContentType: 'application/json',
        }),
      );
    } catch (error) {
      log('error', 'export.manifestUpload.failed', errorContext(error), jobId);
      await writeFailedSentinel(s3Client, deptId, jobId, undefined);
      emitMetric('ExportFailed');
      return;
    }

    emitMetric('ExportCompleted');
  };
}

export const handler = createHandler();
