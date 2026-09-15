import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

const SELF_TEST_RUN_TTL_SECONDS = 60 * 60 * 24 * 365;

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
  readonly overallResult: 'PASS' | 'FAIL';
}

export async function upsertSelfTestRun(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  input: SelfTestRunItem,
): Promise<void> {
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
        ttl: input.runAt + SELF_TEST_RUN_TTL_SECONDS,
      },
    }),
  );
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
