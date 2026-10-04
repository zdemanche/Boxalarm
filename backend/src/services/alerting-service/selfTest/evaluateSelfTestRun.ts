import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import {
  SELF_TEST_METRIC_NAMESPACE,
  completeSelfTestRun,
  type SelfTestChannelResult,
} from './selfTestRunRepository.js';

/**
 * Decides a self-test/canary run from what the channel WORKERS recorded, not from the fan-out's
 * SNS publish (design review C3). The run rode the real fan-out with a one-member audience;
 * each published channel's worker wrote its send guard `RECEIPT#{memberId}#{CHANNEL}#1` under
 * the test dispatch and moved it CLAIMED -> SENT (the provider - sandbox/loopback for tests -
 * accepted it) or FAILED (refused, with failureReason). A channel passes only when its guard is
 * SENT within the latency budget, measured from the trigger to the worker's SENT write.
 *
 * Missing APNs/FCM/SMS credentials, a provider outage, an unreachable endpoint, a worker that
 * never ran, and a member with no target all FAIL here; before, each of them was a PASS.
 */

/** How long a published channel may go without a worker receipt before it is a FAIL. */
export const SELF_TEST_RESULT_TIMEOUT_MS = 30_000;

export interface SelfTestEvaluationOptions {
  /** A channel whose SENT receipt lands later than this after the trigger is a FAIL. */
  readonly latencyBudgetMs: number;
  readonly resultTimeoutMs?: number;
}

export interface EvaluatedSelfTestRun {
  readonly overallResult: 'PASS' | 'FAIL' | 'RUNNING';
  readonly channelResults: Readonly<Record<string, SelfTestChannelResult>>;
  readonly completedAtMs?: number;
  /** The slowest channel's trigger-to-SENT time, when every channel reached SENT. */
  readonly latencyMs?: number;
  readonly eligibilityReason?: string;
}

type ChannelOutcome =
  | { readonly state: 'pending' }
  | { readonly state: 'done'; readonly result: SelfTestChannelResult; readonly atMs: number };

function startedAtMs(run: Record<string, unknown>): number {
  if (typeof run.runAtMs === 'number') {
    return run.runAtMs;
  }
  return typeof run.runAt === 'number' ? run.runAt * 1000 : 0;
}

function asChannelResults(value: unknown): Record<string, SelfTestChannelResult> {
  return typeof value === 'object' && value !== null
    ? { ...(value as Record<string, SelfTestChannelResult>) }
    : {};
}

async function readWorkerOutcome(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  memberId: string,
  channel: string,
  startMs: number,
  latencyBudgetMs: number,
): Promise<ChannelOutcome> {
  const { Item: guard } = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
        sk: `RECEIPT#${memberId}#${channel.toUpperCase()}#1`,
      },
      ConsistentRead: true,
    }),
  );
  if (!guard) {
    return { state: 'pending' };
  }
  const atMs =
    typeof guard.completedAtMs === 'number'
      ? guard.completedAtMs
      : typeof guard.sentAt === 'number'
        ? guard.sentAt * 1000
        : startMs;
  const ms = Math.max(atMs - startMs, 0);
  if (guard.sendState === 'SENT') {
    // Every device only validated (FCM validate_only): the credentials and the token are good,
    // but nothing rang - said so, never passed off as a delivery (review round 2 item b).
    const deviceStates =
      typeof guard.deviceSends === 'object' && guard.deviceSends !== null
        ? Object.values(guard.deviceSends as Record<string, string>)
        : [];
    const validatedOnly = deviceStates.includes('VALIDATED') && !deviceStates.includes('SENT');
    if (validatedOnly && ms <= latencyBudgetMs) {
      return {
        state: 'done',
        atMs,
        result: { ok: true, ms, delivered: false, reason: 'credentials verified, not delivered' },
      };
    }
    return ms <= latencyBudgetMs
      ? { state: 'done', atMs, result: { ok: true, ms } }
      : {
          state: 'done',
          atMs,
          result: {
            ok: false,
            ms,
            reason: `sent in ${ms} ms, over the ${latencyBudgetMs} ms budget`,
          },
        };
  }
  if (guard.sendState === 'FAILED') {
    return {
      state: 'done',
      atMs,
      result: {
        ok: false,
        ms,
        reason: `provider refused: ${typeof guard.failureReason === 'string' ? guard.failureReason : 'unknown'}`,
      },
    };
  }
  return { state: 'pending' };
}

/**
 * Evaluates (and, once decided, records) a SELF_TEST_RUN. A run already PASS/FAIL is returned
 * as it stands; a RUNNING one is resolved from the worker receipts, and stays RUNNING only while
 * a published channel has no final receipt and the timeout has not passed.
 */
export interface SelfTestRunKey {
  readonly deptId: VerifiedDeptId;
  readonly memberId: string;
  readonly testId: string;
}

export async function evaluateSelfTestRun(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  key: SelfTestRunKey,
  run: Record<string, unknown>,
  nowMs: number,
  options: SelfTestEvaluationOptions,
): Promise<EvaluatedSelfTestRun> {
  const channelResults = asChannelResults(run.channelResults);
  const eligibilityReason =
    typeof run.eligibilityReason === 'string' ? run.eligibilityReason : undefined;
  const status = run.overallResult;
  if (status === 'PASS' || status === 'FAIL') {
    return {
      overallResult: status,
      channelResults,
      ...(typeof run.completedAtMs === 'number'
        ? {
            completedAtMs: run.completedAtMs,
            latencyMs: Math.max(run.completedAtMs - startedAtMs(run), 0),
          }
        : {}),
      ...(eligibilityReason ? { eligibilityReason } : {}),
    };
  }

  const { deptId, memberId } = key;
  const startMs = startedAtMs(run);
  const timedOut = nowMs - startMs > (options.resultTimeoutMs ?? SELF_TEST_RESULT_TIMEOUT_MS);
  const channelsTested = Array.isArray(run.channelsTested)
    ? (run.channelsTested as string[]).map((channel) => channel.toUpperCase())
    : [];

  if (typeof run.dispatchId !== 'string' || !Array.isArray(run.publishedChannels)) {
    // The fan-out has not processed the test dispatch (yet).
    if (!timedOut) {
      return { overallResult: 'RUNNING', channelResults };
    }
    const reason = 'fan-out never processed the test dispatch';
    const failed = Object.fromEntries(
      channelsTested.map((channel) => [channel, { ok: false, ms: 0, reason }]),
    );
    await finish(ddb, tableName, key, 'FAIL', failed, nowMs);
    return { overallResult: 'FAIL', channelResults: failed, completedAtMs: nowMs };
  }

  const outcomes = await Promise.all(
    (run.publishedChannels as string[]).map(async (channel) => ({
      channel: channel.toUpperCase(),
      outcome: await readWorkerOutcome(
        ddb,
        tableName,
        deptId,
        run.dispatchId as string,
        memberId,
        channel,
        startMs,
        options.latencyBudgetMs,
      ),
    })),
  );

  const pending = outcomes.filter(({ outcome }) => outcome.state === 'pending');
  const resolved = { ...channelResults };
  let completedAtMs = startMs;
  for (const { channel, outcome } of outcomes) {
    if (outcome.state === 'done') {
      resolved[channel] = outcome.result;
      completedAtMs = Math.max(completedAtMs, outcome.atMs);
    } else if (timedOut) {
      resolved[channel] = {
        ok: false,
        ms: nowMs - startMs,
        reason: 'no worker receipt: the page was published but never sent',
      };
    }
  }
  if (pending.length > 0 && !timedOut) {
    return { overallResult: 'RUNNING', channelResults: resolved };
  }
  if (pending.length > 0) {
    completedAtMs = nowMs;
  }

  const passed =
    eligibilityReason === undefined &&
    channelsTested.length > 0 &&
    channelsTested.every((channel) => resolved[channel]?.ok === true);
  const overallResult = passed ? 'PASS' : 'FAIL';
  await finish(ddb, tableName, key, overallResult, resolved, completedAtMs);
  const latencyMs = Math.max(0, ...Object.values(resolved).map((result) => result.ms));
  return {
    overallResult,
    channelResults: resolved,
    completedAtMs,
    latencyMs,
    ...(eligibilityReason ? { eligibilityReason } : {}),
  };
}

async function finish(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  key: SelfTestRunKey,
  overallResult: 'PASS' | 'FAIL',
  channelResults: Readonly<Record<string, SelfTestChannelResult>>,
  completedAtMs: number,
): Promise<void> {
  const recorded = await completeSelfTestRun(ddb, tableName, key, {
    overallResult,
    channelResults,
    completedAtMs,
  });
  if (recorded) {
    emitOutcomeMetric(
      SELF_TEST_METRIC_NAMESPACE,
      overallResult === 'PASS' ? 'SelfTestPassed' : 'SelfTestFailed',
    );
  }
}
