import { badRequestProblem, notFoundProblem, serviceUnavailableProblem } from '@boxalarm/authz';
import { assertNoDelimiter, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { updateDeliveryReceipt } from './deliveryReceiptRepository.js';
import { extractTraceId, unauthorizedVendorProblem, verifyVendorSecret } from './vendorAuth.js';

const METRIC_NAMESPACE = 'Boxalarm/AlertingReceipts';
const CHANNEL = 'PUSH';

interface PushReceiptWebhookBody {
  readonly deptId: string;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly toneSequence: number;
  readonly status: 'delivered' | 'opened' | 'failed';
  readonly providerTimestamp: number;
  readonly failureReason?: string;
}

function parseProviderTimestamp(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === 'string' && raw.length > 0) {
    const parsedMs = Date.parse(raw);
    return Number.isFinite(parsedMs) ? Math.floor(parsedMs / 1000) : undefined;
  }
  return undefined;
}

export function parsePushReceiptWebhookBody(
  raw: string | undefined | null,
): PushReceiptWebhookBody {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error('body must be valid JSON');
  }
  const body = (parsed ?? {}) as Partial<Record<string, unknown>>;
  if (typeof body.deptId !== 'string' || body.deptId.length === 0) {
    throw new Error('deptId is required');
  }
  if (typeof body.dispatchId !== 'string' || body.dispatchId.length === 0) {
    throw new Error('dispatchId is required');
  }
  if (typeof body.memberId !== 'string' || body.memberId.length === 0) {
    throw new Error('memberId is required');
  }
  if (typeof body.toneSequence !== 'number' || !Number.isInteger(body.toneSequence)) {
    throw new Error('toneSequence is required and must be a number');
  }
  if (body.status !== 'delivered' && body.status !== 'opened' && body.status !== 'failed') {
    throw new Error('status must be one of delivered, opened, failed');
  }
  const providerTimestamp = parseProviderTimestamp(body.providerTimestamp);
  if (providerTimestamp === undefined) {
    throw new Error('providerTimestamp is required and must be a valid timestamp');
  }
  if (
    body.status === 'failed' &&
    (typeof body.failureReason !== 'string' || body.failureReason.length === 0)
  ) {
    throw new Error('failureReason is required when status is failed');
  }
  return {
    deptId: body.deptId,
    dispatchId: body.dispatchId,
    memberId: body.memberId,
    toneSequence: body.toneSequence,
    status: body.status,
    providerTimestamp,
    ...(typeof body.failureReason === 'string' ? { failureReason: body.failureReason } : {}),
  };
}

function logError(event: string, error: unknown, correlationId: string, extra: LogFields): void {
  console.error(
    JSON.stringify({
      event,
      service: 'alerting-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      correlationId,
      ...extra,
    }),
  );
}

type LogFields = Record<string, unknown>;

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const traceId = extractTraceId(event);
  const secret =
    event.headers?.['x-push-provider-secret'] ?? event.headers?.['X-Push-Provider-Secret'];
  const webhookSecret = process.env.PUSH_PROVIDER_WEBHOOK_SECRET;
  if (!webhookSecret || !verifyVendorSecret(secret, webhookSecret)) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'PushReceiptRejected', 'Unauthorized');
    return unauthorizedVendorProblem(
      traceId,
      'Push provider webhook secret is missing or invalid.',
    );
  }

  let body: PushReceiptWebhookBody;
  try {
    body = parsePushReceiptWebhookBody(event.body);
  } catch (error) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'PushReceiptRejected', 'ValidationFailed');
    return badRequestProblem(traceId, error instanceof Error ? error.message : 'invalid body');
  }

  let deptId: VerifiedDeptId;
  try {
    deptId = toVerifiedDeptId({ deptId: body.deptId });
    assertNoDelimiter(body.memberId, 'memberId');
  } catch (error) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'PushReceiptRejected', 'ValidationFailed');
    return badRequestProblem(traceId, error instanceof Error ? error.message : 'invalid body');
  }

  try {
    const client = createDynamoClient(process.env);
    const tableName = readAlertingConfig(process.env).tableName;

    const result = await updateDeliveryReceipt(client, tableName, {
      deptId,
      dispatchId: body.dispatchId,
      memberId: body.memberId,
      channel: CHANNEL,
      toneSequence: body.toneSequence,
      ...(body.status === 'delivered' ? { deliveredAt: body.providerTimestamp } : {}),
      ...(body.status === 'opened' ? { openedAt: body.providerTimestamp } : {}),
      ...(body.status === 'failed' && body.failureReason
        ? { failureReason: body.failureReason }
        : {}),
    });

    if (result.outcome === 'not_found') {
      emitOutcomeMetric(METRIC_NAMESPACE, 'PushReceiptRejected', 'ReceiptNotFound');
      return notFoundProblem(
        traceId,
        'No matching delivery receipt found for this channel attempt',
      );
    }

    emitOutcomeMetric(METRIC_NAMESPACE, 'PushReceiptUpdated');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dispatchId: body.dispatchId,
        memberId: body.memberId,
        channel: CHANNEL,
        status: body.status,
      }),
    };
  } catch (error) {
    logError('alerting.receipts.push.failed', error, traceId, {
      dispatchId: body.dispatchId,
      memberId: body.memberId,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'PushReceiptRejected', 'DynamoUnavailable');
    return serviceUnavailableProblem(traceId);
  }
};
