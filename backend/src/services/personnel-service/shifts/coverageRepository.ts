import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { listMembers } from '../lib/memberRepository.js';
import { readQuals } from '../quals/repository.js';
import { logWarn } from '../lib/logger.js';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { GSI3_INDEX_NAME } from './dynamoClient.js';
import type { CoverageShiftInput } from './coverageAssembly.js';

const SHIFT_POSITION_FETCH_CONCURRENCY = 10;
const QUAL_READ_CONCURRENCY = 10;
const METRICS_NAMESPACE = 'Boxalarm/PersonnelService';

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export async function queryShiftItems(
  doc: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
): Promise<Record<string, unknown>[]> {
  const result = await doc.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :shiftPk',
      ExpressionAttributeValues: { ':shiftPk': pk },
      ConsistentRead: true,
    }),
  );
  return (result.Items ?? []) as Record<string, unknown>[];
}

export async function listDeptShiftMetaItems(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<Record<string, unknown>[]> {
  const gsi3pk = buildDeptScopedPk(deptId, 'DUTY_SHIFT');
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await doc.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: GSI3_INDEX_NAME,
        KeyConditionExpression: 'gsi3pk = :gsi3pk',
        ExpressionAttributeValues: { ':gsi3pk': gsi3pk },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((result.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);
  return items;
}

export async function fetchDeptShiftsWithPositions(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<CoverageShiftInput[]> {
  const shiftMetaItems = await listDeptShiftMetaItems(doc, tableName, deptId);

  // ponytail: app-side status/endAt filter over the full dept shift history (no gsi3sk range
  // condition, since gsi3sk is an unpadded numeric string whose lexicographic order does not
  // match numeric order); upgrade path is zero-padding gsi3sk in shiftAssembly.ts and adding a
  // real KeyConditionExpression range per AP18.
  const now = Date.now();
  const relevantShiftMeta = shiftMetaItems.filter(
    (meta) => meta.status !== 'CANCELLED' && Number(meta.endAt) >= now,
  );

  return mapWithConcurrency(relevantShiftMeta, SHIFT_POSITION_FETCH_CONCURRENCY, async (meta) => {
    const shiftId = String(meta.shiftId);
    const pk = buildDeptScopedPk(deptId, 'SHIFT', shiftId);
    const items = await queryShiftItems(doc, tableName, pk);
    const positions = items
      .filter((item) => typeof item.sk === 'string' && item.sk.startsWith('POSITION#'))
      .map((item) => ({
        positionCode: String(item.positionCode),
        ...(item.requiredQual !== undefined ? { requiredQual: item.requiredQual as string } : {}),
        ...(item.claimedByMemberId !== undefined
          ? { claimedByMemberId: item.claimedByMemberId as string }
          : {}),
      }));
    return {
      shiftId,
      startAt: Number(meta.startAt),
      endAt: Number(meta.endAt),
      stationId: String(meta.stationId),
      positions,
    };
  });
}

// ponytail: no cache-aside layer over the roster/qual fan-out (full recompute on every
// request, bounded to QUAL_READ_CONCURRENCY in flight); ceiling is departmental roster size
// (volunteer-scale, low hundreds). Architecture §6's caching table does not list the
// eligible-qual-code index, and plan §16 forbids new infra for this slice, so the upgrade path
// (ElastiCache Serverless Valkey, cache-aside, short TTL, keyed {deptId}) is deferred to a
// ticket that adds that infra dependency, not assumed here.
export async function buildEligibleQualCodeIndex(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  correlationId: string,
): Promise<ReadonlySet<string>> {
  const members = await listMembers(tableName, { deptId });
  if (members.length === 0) {
    logWarn('shifts.coverage.emptyRoster', correlationId, { deptId });
    emitOutcomeMetric(METRICS_NAMESPACE, 'ShiftCoverageEmptyRoster');
  }
  const perMemberQuals = await mapWithConcurrency(members, QUAL_READ_CONCURRENCY, (member) =>
    readQuals(doc, tableName, deptId, member.memberId),
  );
  const eligibleQualCodes = new Set<string>();
  for (const quals of perMemberQuals) {
    for (const qual of quals) {
      if (qual.currentlyEligible) {
        eligibleQualCodes.add(qual.qualCode);
      }
    }
  }
  return eligibleQualCodes;
}
