import {
  QueryCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';

export async function queryAllPages(
  client: DynamoDBDocumentClient,
  input: Omit<QueryCommandInput, 'ExclusiveStartKey'>,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const output = await client.send(
      new QueryCommand({
        ...input,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    items.push(...(output.Items ?? []));
    exclusiveStartKey = output.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}
