import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk } from '@boxalarm/dept-scope';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import { GSI3_INDEX_NAME } from './dynamoClient.js';

export interface ChecklistItem {
  readonly code: string;
  readonly label: string;
  readonly requiresPhoto: boolean;
  /**
   * Must be answered on its own (brakes, SCBA pressure): the mobile truck check never covers it
   * with "Mark the other N OK". Absent on older records, which reads as false.
   */
  readonly critical: boolean;
}

export interface ChecklistTemplate {
  readonly templateId: string;
  readonly name: string;
  readonly applicableApparatusIds: readonly string[];
  readonly items: readonly ChecklistItem[];
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function apparatusIdFromPartitionKey(partitionKey: string): string | undefined {
  const marker = '#APPARATUS#';
  const index = partitionKey.indexOf(marker);
  return index === -1 ? undefined : partitionKey.slice(index + marker.length);
}

function templateIdFromPartitionKey(partitionKey: string): string | undefined {
  const marker = '#CHECKLIST_TEMPLATE#';
  const index = partitionKey.indexOf(marker);
  return index === -1 ? undefined : partitionKey.slice(index + marker.length);
}

function toChecklistItem(raw: unknown): ChecklistItem {
  const record = raw as Record<string, unknown>;
  return {
    code: readString(record, 'code') ?? '',
    label: readString(record, 'label') ?? '',
    requiresPhoto: record.requiresPhoto === true,
    critical: record.critical === true,
  };
}

function toChecklistTemplate(item: Record<string, unknown>): ChecklistTemplate | undefined {
  const partitionKey = readString(item, 'pk');
  const templateId = partitionKey ? templateIdFromPartitionKey(partitionKey) : undefined;
  if (!templateId) {
    return undefined;
  }
  return {
    templateId,
    name: readString(item, 'name') ?? '',
    applicableApparatusIds: Array.isArray(item.applicableApparatusIds)
      ? item.applicableApparatusIds.filter((id): id is string => typeof id === 'string')
      : [],
    items: Array.isArray(item.items) ? item.items.map(toChecklistItem) : [],
  };
}

export async function resolveApparatusIdByUnitId(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  unitId: string,
): Promise<string | undefined> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: GSI3_INDEX_NAME,
      KeyConditionExpression: 'gsi3pk = :gsi3pk AND gsi3sk = :gsi3sk',
      ExpressionAttributeValues: {
        ':gsi3pk': buildDeptScopedPk(deptId, 'APPARATUS'),
        ':gsi3sk': unitId,
      },
      Limit: 1,
    }),
  );
  const partitionKey = readString(result.Items?.[0], 'pk');
  return partitionKey ? apparatusIdFromPartitionKey(partitionKey) : undefined;
}

export async function resolveChecklistTemplateForUnit(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  apparatusId: string,
): Promise<ChecklistTemplate | undefined> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression:
          'begins_with(pk, :pkPrefix) AND sk = :sk AND contains(applicableApparatusIds, :apparatusId)',
        ExpressionAttributeValues: {
          ':pkPrefix': buildDeptScopedPk(deptId, 'CHECKLIST_TEMPLATE'),
          ':sk': 'METADATA',
          ':apparatusId': apparatusId,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const item = result.Items?.[0];
    if (item) {
      return toChecklistTemplate(item);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return undefined;
}

/** templateId prefix of the department-wide sheet: `department-default-v{version}`. */
export const DEPARTMENT_DEFAULT_TEMPLATE_PREFIX = 'department-default-v';

/**
 * The department's default check sheet: the CHECKLIST_DEFAULTS config the web settings page
 * edits (platform-service/config), stored in this same table under the department's own
 * partition. It is the sheet for any unit no CHECKLIST_TEMPLATE names. The version is part of
 * the templateId, so a check in progress on an older sheet is not restored against a newer one.
 */
export async function resolveDepartmentDefaultTemplate(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<ChecklistTemplate | undefined> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId), sk: 'CONFIG#CHECKLIST_DEFAULTS' },
    }),
  );
  const value = result.Item?.value as Record<string, unknown> | undefined;
  if (!value || !Array.isArray(value.items)) {
    return undefined;
  }
  const version = typeof result.Item?.version === 'number' ? result.Item.version : 0;
  return {
    templateId: `${DEPARTMENT_DEFAULT_TEMPLATE_PREFIX}${version}`,
    name: 'Department check sheet',
    applicableApparatusIds: [],
    items: value.items.map(toChecklistItem),
  };
}
