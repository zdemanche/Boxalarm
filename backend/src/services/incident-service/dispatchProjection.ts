import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { assertNoDelimiter, buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export interface DispatchAlertCopy {
  readonly dispatchId: string;
  readonly deptId: VerifiedDeptId;
  readonly incidentType: string;
  readonly address: string;
  readonly crossStreets: string;
  readonly narrative: string;
  readonly dispatchedAt: number;
  /** A CAD dispatch that couldn't be parsed: the address is a placeholder; read the text. */
  readonly verifyRequired?: true;
}

export interface RosterCopyEntry {
  readonly memberId: string;
  readonly status: string;
  readonly ackAt: number;
}

function dispatchCopyKey(deptId: VerifiedDeptId, dispatchId: string): { pk: string; sk: string } {
  return { pk: buildDeptScopedPk(deptId, 'DISPATCH_COPY', dispatchId), sk: 'METADATA' };
}

export async function putDispatchAlertCopy(
  client: DynamoDBDocumentClient,
  tableName: string,
  copy: DispatchAlertCopy,
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        ...dispatchCopyKey(copy.deptId, copy.dispatchId),
        entityType: 'DISPATCH_ALERT_COPY',
        dispatchId: copy.dispatchId,
        deptId: copy.deptId,
        incidentType: copy.incidentType,
        address: copy.address,
        crossStreets: copy.crossStreets,
        narrative: copy.narrative,
        dispatchedAt: copy.dispatchedAt,
        ...(copy.verifyRequired ? { verifyRequired: true } : {}),
        // Lists the department's dispatches newest first for "Start a report" (GSI1, beside
        // the INCIDENT#{alarmAt} rows in the same department partition).
        gsi1pk: buildDeptScopedPk(copy.deptId),
        gsi1sk: `${DISPATCH_GSI1_PREFIX}${copy.dispatchedAt}`,
      },
    }),
  );
}

const DISPATCH_GSI1_PREFIX = 'DISPATCH#';

export interface RecentDispatch {
  readonly dispatchId: string;
  readonly incidentType: string;
  readonly address: string;
  readonly dispatchedAt: number;
  /** Present (true) only on a CAD dispatch that needs its text read to know where it is. */
  readonly verifyRequired?: true;
  /** The start of the dispatch text, sent only with verifyRequired - the address is not real. */
  readonly textExcerpt?: string;
}

/** How much of an unparsed dispatch's text the list shows in place of its address. */
export const TEXT_EXCERPT_CHARS = 160;

export interface RecentDispatchPage {
  readonly dispatches: readonly RecentDispatch[];
  /** DynamoDB's LastEvaluatedKey when more rows remain in the queried range. */
  readonly lastEvaluatedKey?: Record<string, unknown>;
}

/**
 * This department's dispatch copies with fromSeconds <= dispatchedAt <= toSeconds, newest first.
 * Reads incident-service's own copies (dispatch.alert.received), never the alerting table.
 */
export async function queryRecentDispatchCopies(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  range: {
    readonly fromSeconds: number;
    readonly toSeconds: number;
    readonly limit: number;
    readonly exclusiveStartKey?: Record<string, unknown>;
  },
): Promise<RecentDispatchPage> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':pk': buildDeptScopedPk(deptId),
        ':from': `${DISPATCH_GSI1_PREFIX}${range.fromSeconds}`,
        ':to': `${DISPATCH_GSI1_PREFIX}${range.toSeconds}`,
      },
      ScanIndexForward: false,
      Limit: range.limit,
      ...(range.exclusiveStartKey ? { ExclusiveStartKey: range.exclusiveStartKey } : {}),
    }),
  );
  return {
    dispatches: (result.Items ?? []).map((item) => ({
      dispatchId: String(item.dispatchId),
      incidentType: typeof item.incidentType === 'string' ? item.incidentType : '',
      address: typeof item.address === 'string' ? item.address : '',
      dispatchedAt: Number(item.dispatchedAt),
      ...(item.verifyRequired === true
        ? {
            verifyRequired: true as const,
            textExcerpt:
              typeof item.narrative === 'string' ? item.narrative.slice(0, TEXT_EXCERPT_CHARS) : '',
          }
        : {}),
    })),
    ...(result.LastEvaluatedKey ? { lastEvaluatedKey: result.LastEvaluatedKey } : {}),
  };
}

export interface DispatchReport {
  readonly incidentId: string;
  readonly status: string;
}

/**
 * The report already started from each dispatch, if any. A report created from a dispatch is
 * keyed by the dispatchId (createIncident.ts: incidentId = dispatchId), so this is one
 * BatchGetItem of those METADATA rows. Unprocessed keys are retried a bounded number of times;
 * any still unread are left out, which reads as "no report yet" - the create call then answers
 * 409 rather than making a duplicate.
 */
export async function getReportsForDispatches(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchIds: readonly string[],
): Promise<ReadonlyMap<string, DispatchReport>> {
  const found = new Map<string, DispatchReport>();
  for (let start = 0; start < dispatchIds.length; start += 100) {
    let keys: Record<string, unknown>[] | undefined = dispatchIds
      .slice(start, start + 100)
      .map((dispatchId) => ({
        pk: buildDeptScopedPk(deptId, 'INCIDENT', dispatchId),
        sk: 'METADATA',
      }));
    for (let attempt = 0; keys && keys.length > 0 && attempt < 3; attempt += 1) {
      const result = await client.send(
        new BatchGetCommand({
          RequestItems: {
            [tableName]: {
              Keys: keys,
              ProjectionExpression: 'incidentId, #status',
              ExpressionAttributeNames: { '#status': 'status' },
            },
          },
        }),
      );
      for (const item of result.Responses?.[tableName] ?? []) {
        if (typeof item.incidentId === 'string') {
          found.set(item.incidentId, { incidentId: item.incidentId, status: String(item.status) });
        }
      }
      keys = result.UnprocessedKeys?.[tableName]?.Keys as Record<string, unknown>[] | undefined;
    }
  }
  return found;
}

export async function getDispatchAlertCopy(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<DispatchAlertCopy | undefined> {
  const result = await client.send(
    new GetCommand({ TableName: tableName, Key: dispatchCopyKey(deptId, dispatchId) }),
  );
  return result.Item as DispatchAlertCopy | undefined;
}

/** Last-writer-wins on ackAt (mirrors alerting-service's DISPATCH_ROSTER_ENTRY semantics). */
export async function putRosterCopyEntryIfNewer(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  entry: RosterCopyEntry,
): Promise<'updated' | 'stale'> {
  // Both come off an event payload and become key segments; enforce here rather than
  // trusting every producer/consumer to have validated them.
  assertNoDelimiter(dispatchId, 'dispatchId');
  assertNoDelimiter(entry.memberId, 'memberId');
  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: buildDeptScopedPk(deptId, 'DISPATCH_COPY', dispatchId),
          sk: `ROSTER#${entry.memberId}`,
          entityType: 'DISPATCH_ROSTER_COPY',
          deptId,
          dispatchId,
          memberId: entry.memberId,
          status: entry.status,
          ackAt: entry.ackAt,
        },
        ConditionExpression: 'attribute_not_exists(pk) OR ackAt <= :new',
        ExpressionAttributeValues: { ':new': entry.ackAt },
      }),
    );
    return 'updated';
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return 'stale';
    }
    throw error;
  }
}

export async function queryRosterCopy(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<readonly RosterCopyEntry[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': buildDeptScopedPk(deptId, 'DISPATCH_COPY', dispatchId),
        ':prefix': 'ROSTER#',
      },
    }),
  );
  return (result.Items ?? []) as RosterCopyEntry[];
}

export async function queryIncidentResponseUnits(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  incidentId: string,
  options: { readonly consistent?: boolean } = {},
): Promise<readonly Record<string, unknown>[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': buildDeptScopedPk(deptId, 'INCIDENT', incidentId),
        ':prefix': 'RESPONSE#',
      },
      ...(options.consistent ? { ConsistentRead: true } : {}),
    }),
  );
  return (result.Items ?? []) as Record<string, unknown>[];
}
