import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { GuardEvent } from '@boxalarm/authz';

const DEFAULT_THRESHOLD = 0.95;

export interface MemberDeliveryView {
  readonly memberId: string;
  readonly sent: number;
  readonly delivered: number;
  readonly missedPageCount: number;
  readonly deliveryRate: number;
}

export interface DeliveryBaselineView {
  readonly periodFrom: number;
  readonly periodTo: number;
  readonly deliveryRate: number;
  readonly missedPageCount: number;
  readonly timeToFirstAckAverageSeconds: number | null;
  readonly timeToFirstAckMedianSeconds: number | null;
  readonly perMember: readonly MemberDeliveryView[];
  readonly meetsThreshold: boolean;
  readonly threshold: number;
}

export function readCutoverThreshold(env: NodeJS.ProcessEnv): number {
  const raw = env.CUTOVER_DELIVERY_RATE_THRESHOLD;
  if (!raw) {
    return DEFAULT_THRESHOLD;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('CUTOVER_DELIVERY_RATE_THRESHOLD must be a number between 0 and 1');
  }
  return value;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function readDeliveryBaseline(
  env: NodeJS.ProcessEnv,
  event: GuardEvent,
  from: number,
  to: number,
  lambda: LambdaClient = new LambdaClient({}),
): Promise<DeliveryBaselineView> {
  const functionName = env.DELIVERY_BASELINE_FUNCTION_NAME;
  if (!functionName) {
    throw new Error('DELIVERY_BASELINE_FUNCTION_NAME is required and was not set');
  }
  const threshold = readCutoverThreshold(env);
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      Payload: Buffer.from(
        JSON.stringify({
          headers: event.headers ?? {},
          queryStringParameters: { from: String(from), to: String(to) },
          requestContext: event.requestContext,
        }),
      ),
    }),
  );
  if (response.FunctionError || !response.Payload) {
    throw new Error('delivery baseline lambda failed');
  }
  const parsed = JSON.parse(Buffer.from(response.Payload).toString('utf8')) as {
    statusCode?: number;
    body?: string;
  };
  if (parsed.statusCode !== 200 || typeof parsed.body !== 'string') {
    throw new Error(`delivery baseline lambda returned status ${parsed.statusCode ?? 'unknown'}`);
  }
  const metrics = JSON.parse(parsed.body) as Record<string, unknown>;
  const deliveryRate = typeof metrics.deliveryRate === 'number' ? metrics.deliveryRate : 0;
  const perMemberRaw = Array.isArray(metrics.perMember) ? metrics.perMember : [];
  const perMember: MemberDeliveryView[] = [];
  for (const entry of perMemberRaw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.memberId !== 'string') {
      continue;
    }
    const sent = typeof record.sent === 'number' ? record.sent : 0;
    const delivered = typeof record.delivered === 'number' ? record.delivered : 0;
    perMember.push({
      memberId: record.memberId,
      sent,
      delivered,
      missedPageCount: typeof record.missedPageCount === 'number' ? record.missedPageCount : 0,
      deliveryRate: sent === 0 ? 0 : delivered / sent,
    });
  }
  return {
    periodFrom: from,
    periodTo: to,
    deliveryRate,
    missedPageCount: typeof metrics.missedPageCount === 'number' ? metrics.missedPageCount : 0,
    timeToFirstAckAverageSeconds: numberOrNull(metrics.timeToFirstAckAverageSeconds),
    timeToFirstAckMedianSeconds: numberOrNull(metrics.timeToFirstAckMedianSeconds),
    perMember,
    meetsThreshold: deliveryRate >= threshold,
    threshold,
  };
}
