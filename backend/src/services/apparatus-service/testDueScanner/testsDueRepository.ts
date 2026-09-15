import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { readApparatusTableConfig } from '../dynamoClient.js';

export interface TestDueRecord {
  readonly apparatusId: string;
  readonly testType: string;
  readonly dueDate: string;
}

export interface QueryTestsDueInMonthParams {
  readonly deptId: VerifiedDeptId;
  readonly yearMonth: string;
  readonly correlationId: string;
}

function toTestDueRecord(item: Record<string, unknown>): TestDueRecord | undefined {
  const gsi2sk = item.gsi2sk;
  if (typeof gsi2sk !== 'string') {
    return undefined;
  }
  const [dueDate, apparatusId, testType] = gsi2sk.split('#');
  if (!dueDate || !apparatusId || !testType) {
    return undefined;
  }
  return { apparatusId, testType, dueDate };
}

export async function queryTestsDueInMonth(
  client: DynamoDBDocumentClient,
  env: NodeJS.ProcessEnv,
  params: QueryTestsDueInMonthParams,
): Promise<readonly TestDueRecord[]> {
  const { tableName } = readApparatusTableConfig(env);
  try {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const output = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI2',
          KeyConditionExpression: 'gsi2pk = :gsi2pk',
          ExpressionAttributeValues: {
            ':gsi2pk': buildDeptScopedPk(params.deptId, 'DUE', 'APPARATUS_TEST', params.yearMonth),
          },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items.push(...(output.Items ?? []));
      exclusiveStartKey = output.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items
      .map(toTestDueRecord)
      .filter((record): record is TestDueRecord => record !== undefined);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'testDueScanner.queryDueInMonth.failed',
        service: 'apparatus',
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        correlationId: params.correlationId,
      }),
    );
    throw error;
  }
}
