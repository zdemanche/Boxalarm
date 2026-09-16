import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { readApparatusTableConfig } from '../dynamoClient.js';
import { parseTestDueItem, type TestDueItem } from '../testRecord.js';

export interface TestDueRecord {
  readonly apparatusId: string;
  readonly testType: string;
  readonly dueDate: string;
}

export interface QueryTestsDueParams {
  readonly deptId: VerifiedDeptId;
  readonly startDate: string;
  readonly endDate: string;
  readonly correlationId: string;
}

// Sorts after any real apparatusId/testType suffix, so `sk BETWEEN start AND end#SENTINEL`
// correctly includes every entry whose date component equals the end date.
const RANGE_END_SENTINEL = '￿';

export async function queryTestsDue(
  client: DynamoDBDocumentClient,
  env: NodeJS.ProcessEnv,
  params: QueryTestsDueParams,
): Promise<readonly TestDueRecord[]> {
  const { tableName } = readApparatusTableConfig(env);
  try {
    const items: TestDueItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const output = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI2',
          KeyConditionExpression: 'gsi2pk = :gsi2pk AND gsi2sk BETWEEN :start AND :end',
          ExpressionAttributeValues: {
            ':gsi2pk': buildDeptScopedPk(params.deptId, 'DUE', 'APPARATUS_TEST'),
            ':start': params.startDate,
            ':end': `${params.endDate}#${RANGE_END_SENTINEL}`,
          },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items.push(...((output.Items ?? []) as TestDueItem[]));
      exclusiveStartKey = output.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items
      .map(parseTestDueItem)
      .map((entry) => ({
        apparatusId: entry.apparatusId,
        testType: entry.testType,
        dueDate: entry.nextDueDate,
      }));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'testDueScanner.queryDue.failed',
        service: 'apparatus',
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : undefined,
        correlationId: params.correlationId,
      }),
    );
    throw error;
  }
}
