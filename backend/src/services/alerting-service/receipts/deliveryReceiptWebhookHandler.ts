import { badRequestProblem, notFoundProblem, serviceUnavailableProblem } from '@boxalarm/authz';
import { assertNoDelimiter, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import {
  deriveDeptIdFromDispatchId,
  updateDeliveryReceipt,
  type DeliveryChannel,
} from './deliveryReceiptRepository.js';
import { logError, logInfo } from './logger.js';
import { extractTraceId, unauthorizedVendorProblem, verifyVendorSecret } from './vendorAuth.js';

const METRIC_NAMESPACE = 'Boxalarm/AlertingReceipts';

export interface ReceiptWebhookBody {
  readonly dispatchId: string;
  readonly memberId: string;
  readonly toneSequence: number;
  readonly status: string;
  readonly providerTimestamp: number;
  readonly failureReason?: string;
}

export function parseProviderTimestamp(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === 'string' && raw.length > 0) {
    const parsedMs = Date.parse(raw);
    return Number.isFinite(parsedMs) ? Math.floor(parsedMs / 1000) : undefined;
  }
  return undefined;
}

export function parseReceiptWebhookBody(
  raw: string | undefined | null,
  allowedStatuses: readonly string[],
): ReceiptWebhookBody {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error('body must be valid JSON');
  }
  const body = (parsed ?? {}) as Partial<Record<string, unknown>>;
  if (typeof body.dispatchId !== 'string' || body.dispatchId.length === 0) {
    throw new Error('dispatchId is required');
  }
  if (typeof body.memberId !== 'string' || body.memberId.length === 0) {
    throw new Error('memberId is required');
  }
  if (typeof body.toneSequence !== 'number' || !Number.isInteger(body.toneSequence)) {
    throw new Error('toneSequence is required and must be a number');
  }
  if (typeof body.status !== 'string' || !allowedStatuses.includes(body.status)) {
    throw new Error(`status must be one of ${allowedStatuses.join(', ')}`);
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
    dispatchId: body.dispatchId,
    memberId: body.memberId,
    toneSequence: body.toneSequence,
    status: body.status,
    providerTimestamp,
    ...(typeof body.failureReason === 'string' ? { failureReason: body.failureReason } : {}),
  };
}

export interface ReceiptWebhookHandlerConfig {
  readonly channel: DeliveryChannel;
  readonly vendorLabel: string;
  readonly secretHeaderName: string;
  readonly secretEnvVar: string;
  readonly allowedStatuses: readonly string[];
  readonly openedStatus?: string;
  readonly metricPrefix: string;
  readonly logPrefix: string;
}

function readHeader(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const headers = event.headers ?? {};
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

export function createDeliveryReceiptWebhookHandler(
  config: ReceiptWebhookHandlerConfig,
): (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2> {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const traceId = extractTraceId(event);
    const secret = readHeader(event, config.secretHeaderName);
    const webhookSecret = process.env[config.secretEnvVar];
    if (!webhookSecret || !verifyVendorSecret(secret, webhookSecret)) {
      emitOutcomeMetric(METRIC_NAMESPACE, `${config.metricPrefix}ReceiptRejected`, 'Unauthorized');
      logInfo({
        event: `${config.logPrefix}.unauthorized`,
        service: 'alerting-service',
        traceId,
        hasSecret: Boolean(secret),
      });
      return unauthorizedVendorProblem(
        traceId,
        `${config.vendorLabel} provider webhook secret is missing or invalid.`,
      );
    }

    let body: ReceiptWebhookBody;
    try {
      body = parseReceiptWebhookBody(event.body, config.allowedStatuses);
      assertNoDelimiter(body.memberId, 'memberId');
      assertNoDelimiter(body.dispatchId, 'dispatchId');
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'invalid body';
      emitOutcomeMetric(
        METRIC_NAMESPACE,
        `${config.metricPrefix}ReceiptRejected`,
        'ValidationFailed',
      );
      logInfo({
        event: `${config.logPrefix}.rejected`,
        service: 'alerting-service',
        traceId,
        reason: detail,
      });
      return badRequestProblem(traceId, detail);
    }

    let deptId;
    try {
      deptId = toVerifiedDeptId({ deptId: deriveDeptIdFromDispatchId(body.dispatchId) });
    } catch (error) {
      emitOutcomeMetric(
        METRIC_NAMESPACE,
        `${config.metricPrefix}ReceiptRejected`,
        'ValidationFailed',
      );
      return badRequestProblem(
        traceId,
        error instanceof Error ? error.message : 'invalid dispatchId',
      );
    }

    try {
      const client = createDynamoClient(process.env);
      const tableName = readAlertingConfig(process.env).tableName;

      const result = await updateDeliveryReceipt(client, tableName, {
        deptId,
        dispatchId: body.dispatchId,
        memberId: body.memberId,
        channel: config.channel,
        toneSequence: body.toneSequence,
        ...(body.status === 'delivered' ? { deliveredAt: body.providerTimestamp } : {}),
        ...(config.openedStatus && body.status === config.openedStatus
          ? { openedAt: body.providerTimestamp }
          : {}),
        ...(body.status === 'failed' && body.failureReason
          ? { failureReason: body.failureReason }
          : {}),
      });

      if (result.outcome === 'not_found') {
        emitOutcomeMetric(
          METRIC_NAMESPACE,
          `${config.metricPrefix}ReceiptRejected`,
          'ReceiptNotFound',
        );
        return notFoundProblem(
          traceId,
          'No matching delivery receipt found for this channel attempt',
        );
      }

      emitOutcomeMetric(METRIC_NAMESPACE, `${config.metricPrefix}ReceiptUpdated`);
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dispatchId: body.dispatchId,
          memberId: body.memberId,
          channel: config.channel,
          status: body.status,
        }),
      };
    } catch (error) {
      logError({
        event: `${config.logPrefix}.failed`,
        service: 'alerting-service',
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
        traceId,
        dispatchId: body.dispatchId,
        memberId: body.memberId,
      });
      emitOutcomeMetric(
        METRIC_NAMESPACE,
        `${config.metricPrefix}ReceiptRejected`,
        'DynamoUnavailable',
      );
      return serviceUnavailableProblem(traceId);
    }
  };
}
