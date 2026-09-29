import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export const SELF_TEST_METRIC_NAMESPACE = 'Boxalarm/AlertingSelfTest';

const SELF_TEST_RUN_TTL_SECONDS = 60 * 60 * 24 * 365;
export const SELF_TEST_COOLDOWN_SECONDS = 60;

export interface SelfTestChannelResult {
  readonly ok: boolean;
  readonly ms: number;
  readonly reason?: string;
}

export interface SelfTestRunItem {
  readonly deptId: VerifiedDeptId;
  readonly memberId: string;
  readonly testId: string;
  readonly runAt: number;
  readonly channelsTested: readonly string[];
  readonly channelResults: Readonly<Record<string, SelfTestChannelResult>>;
  readonly overallResult: 'PASS' | 'FAIL' | 'RUNNING';
  readonly eligibilityReason?: string;
  /**
   * Epoch ms at which the run's final PASS/FAIL was decided - from the workers' receipts
   * (evaluateSelfTestRun.ts), or by the fan-out when nothing could be published.
   */
  readonly completedAtMs?: number;
  /** Epoch ms the run was triggered: the start of its ingress-to-delivery latency. */
  readonly runAtMs?: number;
}

export async function upsertSelfTestRun(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  input: SelfTestRunItem,
  options: { readonly onlyIfAbsent?: boolean } = {},
): Promise<void> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: buildDeptScopedPk(input.deptId, 'MEMBER', input.memberId),
          sk: `SELFTEST#${input.testId}`,
          entityType: 'SELF_TEST_RUN',
          deptId: input.deptId,
          memberId: input.memberId,
          testId: input.testId,
          runAt: input.runAt,
          channelsTested: input.channelsTested,
          channelResults: input.channelResults,
          overallResult: input.overallResult,
          ...(input.eligibilityReason ? { eligibilityReason: input.eligibilityReason } : {}),
          ...(input.completedAtMs !== undefined ? { completedAtMs: input.completedAtMs } : {}),
          ...(input.runAtMs !== undefined ? { runAtMs: input.runAtMs } : {}),
          ttl: input.runAt + SELF_TEST_RUN_TTL_SECONDS,
        },
        ...(options.onlyIfAbsent ? { ConditionExpression: 'attribute_not_exists(pk)' } : {}),
      }),
    );
  } catch (error) {
    if (options.onlyIfAbsent && error instanceof ConditionalCheckFailedException) {
      return;
    }
    throw error;
  }
}

export interface SelfTestFanOutRecord {
  readonly deptId: VerifiedDeptId;
  readonly memberId: string;
  readonly testId: string;
  readonly runAt: number;
  readonly dispatchId: string;
  readonly channelsTested: readonly string[];
  /** Channels the fan-out published; their outcome is the worker's receipt, not the publish. */
  readonly publishedChannels: readonly string[];
  /** Channels that could not be published, with why (no target, publish failed). */
  readonly channelResults: Readonly<Record<string, SelfTestChannelResult>>;
  readonly eligibilityReason?: string;
  readonly nowMs: number;
}

/**
 * The fan-out's half of a self-test/canary run: which dispatch it rode and which channels were
 * published. A run with published channels stays RUNNING - PASS needs the workers' receipts
 * (evaluateSelfTestRun.ts), never the SNS publish. One with nothing published is FAIL now.
 * An update, not a put: it keeps runAt/runAtMs/ttl from the trigger (post handler, canary),
 * seeding them only if the trigger's own write has not landed yet.
 */
export async function recordSelfTestFanOut(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  input: SelfTestFanOutRecord,
): Promise<void> {
  const final = input.publishedChannels.length === 0;
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: {
        pk: buildDeptScopedPk(input.deptId, 'MEMBER', input.memberId),
        sk: `SELFTEST#${input.testId}`,
      },
      UpdateExpression: [
        'SET entityType = :entityType',
        'deptId = :deptId',
        'memberId = :memberId',
        'testId = :testId',
        'runAt = if_not_exists(runAt, :runAt)',
        '#ttl = if_not_exists(#ttl, :ttl)',
        'channelsTested = :channelsTested',
        'dispatchId = :dispatchId',
        'publishedChannels = :publishedChannels',
        'channelResults = :channelResults',
        'overallResult = :overallResult',
        'fanOutCompletedAtMs = :nowMs',
        ...(final ? ['completedAtMs = :nowMs'] : []),
        ...(input.eligibilityReason ? ['eligibilityReason = :eligibilityReason'] : []),
      ].join(', '),
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':entityType': 'SELF_TEST_RUN',
        ':deptId': input.deptId,
        ':memberId': input.memberId,
        ':testId': input.testId,
        ':runAt': input.runAt,
        ':ttl': input.runAt + SELF_TEST_RUN_TTL_SECONDS,
        ':channelsTested': input.channelsTested,
        ':dispatchId': input.dispatchId,
        ':publishedChannels': input.publishedChannels,
        ':channelResults': input.channelResults,
        ':overallResult': final ? 'FAIL' : 'RUNNING',
        ':nowMs': input.nowMs,
        ...(input.eligibilityReason ? { ':eligibilityReason': input.eligibilityReason } : {}),
      },
    }),
  );
}

/**
 * Records a run's final result once: only while it is still RUNNING, so two concurrent
 * evaluators (the member polling, the canary) cannot overwrite each other's decision.
 * Returns false when another evaluator already finished it.
 */
export async function completeSelfTestRun(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  key: { readonly deptId: VerifiedDeptId; readonly memberId: string; readonly testId: string },
  result: {
    readonly overallResult: 'PASS' | 'FAIL';
    readonly channelResults: Readonly<Record<string, SelfTestChannelResult>>;
    readonly completedAtMs: number;
  },
): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          pk: buildDeptScopedPk(key.deptId, 'MEMBER', key.memberId),
          sk: `SELFTEST#${key.testId}`,
        },
        UpdateExpression:
          'SET overallResult = :result, channelResults = :channelResults, completedAtMs = :completedAtMs',
        ConditionExpression: 'overallResult = :running',
        ExpressionAttributeValues: {
          ':result': result.overallResult,
          ':channelResults': result.channelResults,
          ':completedAtMs': result.completedAtMs,
          ':running': 'RUNNING',
        },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw error;
  }
}

export async function getSelfTestRun(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  testId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'MEMBER', memberId), sk: `SELFTEST#${testId}` },
    }),
  );
  return result.Item;
}

export async function acquireSelfTestCooldown(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  runAt: number,
): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: buildDeptScopedPk(deptId, 'MEMBER', memberId),
          sk: 'SELFTEST_COOLDOWN',
          entityType: 'SELF_TEST_COOLDOWN',
          deptId,
          memberId,
          expiresAt: runAt + SELF_TEST_COOLDOWN_SECONDS,
          ttl: runAt + SELF_TEST_COOLDOWN_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now',
        ExpressionAttributeValues: { ':now': runAt },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw error;
  }
}
