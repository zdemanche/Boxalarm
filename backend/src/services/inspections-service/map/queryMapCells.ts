import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export interface MapOccupancy {
  readonly occupancyId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly gsi3pk: string;
  readonly gsi3sk: string;
}

export interface MapHydrant {
  readonly hydrantId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly status: string;
  readonly gsi3pk: string;
  readonly gsi3sk: string;
}

export interface MapQueryResult {
  readonly occupancies: readonly MapOccupancy[];
  readonly hydrants: readonly MapHydrant[];
}

type RawItem = Record<string, unknown>;
type EntityType = 'OCCUPANCY' | 'HYDRANT';

const HYDRANT_STATUSES = new Set(['IN_SERVICE', 'OUT_OF_SERVICE']);

function extractEntityId(recordPk: string): string {
  const segments = recordPk.split('#');
  return segments[segments.length - 1] ?? '';
}

function emitSkippedItemMetric(entityType: EntityType, reason: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/InspectionsMap',
            Dimensions: [['EntityType', 'Reason']],
            Metrics: [{ Name: 'MapItemSkipped', Unit: 'Count' }],
          },
        ],
      },
      EntityType: entityType,
      Reason: reason,
      MapItemSkipped: 1,
    }),
  );
}

function logSkippedItem(
  entityType: EntityType,
  reason: string,
  recordPk: string | undefined,
  recordGsi3pk: string | undefined,
): void {
  console.warn(
    JSON.stringify({
      event: 'inspections-map.item-skipped',
      service: 'inspections-service',
      entityType,
      reason,
      recordPk,
      recordGsi3pk,
    }),
  );
}

async function queryEntityCells(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  entityType: EntityType,
  cells: readonly string[],
): Promise<RawItem[]> {
  const projectionExpression =
    entityType === 'HYDRANT'
      ? 'pk, latitude, longitude, #status, gsi3pk, gsi3sk'
      : 'pk, latitude, longitude, gsi3pk, gsi3sk';
  const expressionAttributeNames = entityType === 'HYDRANT' ? { '#status': 'status' } : undefined;

  const perCell = await Promise.all(
    cells.map(async (cell) => {
      const items: RawItem[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const output = await doc.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: 'GSI3',
            KeyConditionExpression: 'gsi3pk = :cellKey',
            ExpressionAttributeValues: {
              ':cellKey': buildDeptScopedPk(deptId, entityType, 'GEO', cell),
            },
            ProjectionExpression: projectionExpression,
            ...(expressionAttributeNames
              ? { ExpressionAttributeNames: expressionAttributeNames }
              : {}),
            ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          }),
        );
        items.push(...((output.Items ?? []) as RawItem[]));
        exclusiveStartKey = output.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (exclusiveStartKey);
      return items;
    }),
  );
  return perCell.flat();
}

export async function queryMapCells(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  cells: readonly string[],
): Promise<MapQueryResult> {
  const [occupancyItems, hydrantItems] = await Promise.all([
    queryEntityCells(doc, tableName, deptId, 'OCCUPANCY', cells),
    queryEntityCells(doc, tableName, deptId, 'HYDRANT', cells),
  ]);

  const occupancies = new Map<string, MapOccupancy>();
  for (const item of occupancyItems) {
    const recordPk = String(item['pk']);
    const latitude = Number(item['latitude']);
    const longitude = Number(item['longitude']);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      logSkippedItem('OCCUPANCY', 'InvalidGeo', item['pk'] as string, item['gsi3pk'] as string);
      emitSkippedItemMetric('OCCUPANCY', 'InvalidGeo');
      continue;
    }
    occupancies.set(recordPk, {
      occupancyId: extractEntityId(recordPk),
      latitude,
      longitude,
      gsi3pk: String(item['gsi3pk']),
      gsi3sk: String(item['gsi3sk']),
    });
  }

  const hydrants = new Map<string, MapHydrant>();
  for (const item of hydrantItems) {
    const recordPk = String(item['pk']);
    const latitude = Number(item['latitude']);
    const longitude = Number(item['longitude']);
    const status = item['status'];
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      logSkippedItem('HYDRANT', 'InvalidGeo', item['pk'] as string, item['gsi3pk'] as string);
      emitSkippedItemMetric('HYDRANT', 'InvalidGeo');
      continue;
    }
    if (typeof status !== 'string' || !HYDRANT_STATUSES.has(status)) {
      logSkippedItem('HYDRANT', 'InvalidStatus', item['pk'] as string, item['gsi3pk'] as string);
      emitSkippedItemMetric('HYDRANT', 'InvalidStatus');
      continue;
    }
    hydrants.set(recordPk, {
      hydrantId: extractEntityId(recordPk),
      latitude,
      longitude,
      status,
      gsi3pk: String(item['gsi3pk']),
      gsi3sk: String(item['gsi3sk']),
    });
  }

  return {
    occupancies: Array.from(occupancies.values()),
    hydrants: Array.from(hydrants.values()),
  };
}
