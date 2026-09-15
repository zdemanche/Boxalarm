import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { logError, type TrainingConfig } from './client.js';

const QUERY_PAGE_SIZE = 100;

export interface TrainingEventInput {
  readonly title: string;
  readonly category: string;
  readonly startAt: number;
  readonly endAt: number;
}

export interface TrainingEvent extends TrainingEventInput {
  readonly eventId: string;
}

export interface AttendeeHoursInput {
  readonly memberId: string;
  readonly hours: number;
}

export class DuplicateSignupError extends Error {
  constructor() {
    super('Member is already signed up for this training event');
    this.name = 'DuplicateSignupError';
  }
}

function toTrainingEvent(item: Record<string, unknown>): TrainingEvent {
  return {
    eventId: item.eventId as string,
    title: item.title as string,
    category: item.category as string,
    startAt: item.startAt as number,
    endAt: item.endAt as number,
  };
}

async function queryAllPages(
  client: DynamoDBDocumentClient,
  buildCommand: (exclusiveStartKey?: Record<string, unknown>) => QueryCommand,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const output = await client.send(buildCommand(exclusiveStartKey));
    items.push(...(output.Items ?? []));
    exclusiveStartKey = output.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

export async function createTrainingEvent(
  client: DynamoDBDocumentClient,
  config: TrainingConfig,
  deptId: VerifiedDeptId,
  input: TrainingEventInput,
): Promise<TrainingEvent> {
  const eventId = randomUUID();
  await client.send(
    new PutCommand({
      TableName: config.tableName,
      Item: {
        pk: buildDeptScopedPk(deptId, 'TRAINING_EVENT', eventId),
        sk: 'METADATA',
        entityType: 'TRAINING_EVENT',
        eventId,
        title: input.title,
        category: input.category,
        startAt: input.startAt,
        endAt: input.endAt,
        gsi3pk: buildDeptScopedPk(deptId, 'TRAINING_EVENT'),
        gsi3sk: String(input.startAt),
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
  return { eventId, ...input };
}

export async function listTrainingEvents(
  client: DynamoDBDocumentClient,
  config: TrainingConfig,
  deptId: VerifiedDeptId,
): Promise<readonly TrainingEvent[]> {
  const items = await queryAllPages(
    client,
    (exclusiveStartKey) =>
      new QueryCommand({
        TableName: config.tableName,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :gsi3pk',
        ExpressionAttributeValues: { ':gsi3pk': buildDeptScopedPk(deptId, 'TRAINING_EVENT') },
        ScanIndexForward: true,
        Limit: QUERY_PAGE_SIZE,
        ExclusiveStartKey: exclusiveStartKey,
      }),
  );
  return items.map(toTrainingEvent);
}

export async function getTrainingEvent(
  client: DynamoDBDocumentClient,
  config: TrainingConfig,
  deptId: VerifiedDeptId,
  eventId: string,
): Promise<TrainingEvent | undefined> {
  const output = await client.send(
    new GetCommand({
      TableName: config.tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'TRAINING_EVENT', eventId), sk: 'METADATA' },
    }),
  );
  return output.Item ? toTrainingEvent(output.Item) : undefined;
}

export async function listMemberAttendanceEventIds(
  client: DynamoDBDocumentClient,
  config: TrainingConfig,
  memberId: string,
): Promise<ReadonlySet<string>> {
  const items = await queryAllPages(
    client,
    (exclusiveStartKey) =>
      new QueryCommand({
        TableName: config.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)',
        ExpressionAttributeValues: {
          ':gsi1pk': `MEMBER#${memberId}`,
          ':prefix': 'TRAINING_ATTENDANCE#',
        },
        ProjectionExpression: 'eventId',
        Limit: QUERY_PAGE_SIZE,
        ExclusiveStartKey: exclusiveStartKey,
      }),
  );
  return new Set(items.map((item) => item.eventId as string));
}

export interface MemberAttendanceRecord {
  readonly eventId: string;
  readonly category: string;
  readonly hours: number;
  readonly startAt: number;
}

const ATTENDANCE_GSI1SK_PREFIX = 'TRAINING_ATTENDANCE#';

function toMemberAttendanceRecord(item: Record<string, unknown>): MemberAttendanceRecord {
  const gsi1sk = item.gsi1sk as string;
  return {
    eventId: item.eventId as string,
    category: item.category as string,
    hours: (item.hours as number | undefined) ?? 0,
    startAt: Number(gsi1sk.slice(ATTENDANCE_GSI1SK_PREFIX.length)),
  };
}

export async function listMemberAttendanceRecords(
  client: DynamoDBDocumentClient,
  config: TrainingConfig,
  memberId: string,
): Promise<readonly MemberAttendanceRecord[]> {
  const items = await queryAllPages(
    client,
    (exclusiveStartKey) =>
      new QueryCommand({
        TableName: config.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)',
        ExpressionAttributeValues: {
          ':gsi1pk': `MEMBER#${memberId}`,
          ':prefix': ATTENDANCE_GSI1SK_PREFIX,
        },
        ProjectionExpression: 'eventId, category, hours, gsi1sk',
        Limit: QUERY_PAGE_SIZE,
        ExclusiveStartKey: exclusiveStartKey,
      }),
  );
  return items.map(toMemberAttendanceRecord);
}

export async function createSignupAttendance(
  client: DynamoDBDocumentClient,
  config: TrainingConfig,
  deptId: VerifiedDeptId,
  event: TrainingEvent,
  memberId: string,
): Promise<void> {
  try {
    await client.send(
      new PutCommand({
        TableName: config.tableName,
        Item: {
          pk: buildDeptScopedPk(deptId, 'TRAINING_EVENT', event.eventId),
          sk: `ATTENDEE#${memberId}`,
          entityType: 'TRAINING_ATTENDANCE',
          eventId: event.eventId,
          memberId,
          category: event.category,
          gsi1pk: `MEMBER#${memberId}`,
          gsi1sk: `TRAINING_ATTENDANCE#${event.startAt}`,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      logError('training.repository.signup.duplicate', error, {
        deptId,
        eventId: event.eventId,
        memberId,
      });
      throw new DuplicateSignupError();
    }
    throw error;
  }
}

export async function recordAttendanceHours(
  client: DynamoDBDocumentClient,
  config: TrainingConfig,
  deptId: VerifiedDeptId,
  event: TrainingEvent,
  attendees: readonly AttendeeHoursInput[],
): Promise<void> {
  const pk = buildDeptScopedPk(deptId, 'TRAINING_EVENT', event.eventId);
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: attendees.map((attendee) => ({
          Update: {
            TableName: config.tableName,
            Key: { pk, sk: `ATTENDEE#${attendee.memberId}` },
            UpdateExpression:
              'SET hours = :hours, ' +
              'entityType = if_not_exists(entityType, :entityType), ' +
              'eventId = if_not_exists(eventId, :eventId), ' +
              'memberId = if_not_exists(memberId, :memberId), ' +
              'category = if_not_exists(category, :category), ' +
              'gsi1pk = if_not_exists(gsi1pk, :gsi1pk), ' +
              'gsi1sk = if_not_exists(gsi1sk, :gsi1sk)',
            ExpressionAttributeValues: {
              ':hours': attendee.hours,
              ':entityType': 'TRAINING_ATTENDANCE',
              ':eventId': event.eventId,
              ':memberId': attendee.memberId,
              ':category': event.category,
              ':gsi1pk': `MEMBER#${attendee.memberId}`,
              ':gsi1sk': `TRAINING_ATTENDANCE#${event.startAt}`,
            },
          },
        })),
      }),
    );
  } catch (error) {
    logError('training.repository.record_hours.failed', error, { deptId, eventId: event.eventId });
    throw error;
  }
}
