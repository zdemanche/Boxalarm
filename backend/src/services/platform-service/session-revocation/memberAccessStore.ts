import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  withoutAllDevices,
  withoutDevice,
  writePushDevices,
  type ContactChannelEntry,
} from '../../personnel-service/pushTokens/pushDevices.js';

export function readPlatformTableName(env: NodeJS.ProcessEnv): string {
  const tableName = env.PLATFORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return tableName;
}

let cachedDocClient: DynamoDBDocumentClient | undefined;

export function getAccessStoreClient(override?: DynamoDBDocumentClient): DynamoDBDocumentClient {
  if (override) {
    return override;
  }
  cachedDocClient ??= DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient({})));
  return cachedDocClient;
}

/**
 * The member row's current status, or undefined when there is no row. Session revocation
 * acts on this rather than on the status an event carries: the queue is standard SQS, so
 * LOA -> ACTIVE in quick succession can be delivered out of order. Reading the row is not
 * enough on its own (the row can change between the read and the Cognito call), so the
 * consumer re-reads after acting and reconciles - see convergeLoginState.
 */
export async function readMemberStatus(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: string,
  memberId: string,
): Promise<string | undefined> {
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        pk: buildDeptScopedPk(toVerifiedDeptId({ deptId }), 'MEMBER', memberId),
        sk: 'METADATA',
      },
      ProjectionExpression: '#status',
      ExpressionAttributeNames: { '#status': 'status' },
      ConsistentRead: true,
    }),
  );
  const status: unknown = result.Item?.status;
  return typeof status === 'string' ? status : undefined;
}

export type PushInvalidationResult = 'invalidated' | 'no-push-entry' | 'no-member';

/**
 * Device loss (review M2): stop the lost phone receiving dispatch pushes - incident type and
 * address on the lock screen - by removing its push device entry from the member row. The
 * write is personnel's own writePushDevices (the only writer of a member's push devices), so
 * it shares the device model, the updatedAt guard with re-read and retry, the event time
 * stamped max(now, previous updatedAt + 1) - strictly after a registration in the same
 * millisecond, so the alerting projection never drops it as stale - and the
 * personnel.member.updated event shape. `changedBy` on the payload records that platform-service
 * device loss (and which admin) made the change, not the member's own sign-out.
 *
 * Decision (2026-09-29, coordinator): when the admin identifies the lost device (`deviceId`)
 * only that device is removed and the member's other devices keep being paged; otherwise
 * every push device is removed. The global sign-out still ends every session either way.
 *
 * Review minor 1: the event is ALWAYS written, with the member's current device list, even
 * when nothing was removed ('no-push-entry'). The alerting snapshot is a projection that can
 * drift from the member row (a lost or out-of-order event); device loss is the moment an
 * admin says "this phone must stop", so it re-asserts the row's list and repairs the
 * snapshot instead of trusting it.
 */
export async function invalidateMemberPush(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: string,
  memberId: string,
  correlationId: string,
  actorId: string,
  deviceId?: string,
): Promise<PushInvalidationResult> {
  // Re-set on every attempt: writePushDevices re-reads and re-applies after a lost race.
  let removed = false;
  const outcome = await writePushDevices(
    docClient,
    tableName,
    toVerifiedDeptId({ deptId }),
    memberId,
    (current) => {
      const next =
        deviceId === undefined ? withoutAllDevices(current) : withoutDevice(current, deviceId);
      removed = next.length !== current.length;
      return next;
    },
    {
      correlationId,
      changedBy: {
        service: 'platform-service',
        reason: 'DEVICE_LOSS',
        actorId,
        ...(deviceId !== undefined ? { deviceId } : {}),
      },
    },
  );
  if (outcome === 'not_found') {
    return 'no-member';
  }
  return removed ? 'invalidated' : 'no-push-entry';
}

/**
 * The member's registered push devices, for the "report device lost" dialog: platform, when
 * it last registered, and its installation id (legacy entries have none).
 */
/** A push device as an admin sees it: never the token itself. */
export interface RegisteredDevice {
  readonly deviceId: string | null;
  readonly platform: string | null;
  readonly registeredAt: number | null;
  readonly valid: boolean;
}

/**
 * The member's push devices, newest registration first; undefined when there is no member row
 * in `deptId`. A legacy entry (registered before the app sent an installation id) has
 * deviceId null and can only be removed with the rest ("All devices").
 */
export async function listMemberDevices(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: string,
  memberId: string,
): Promise<readonly RegisteredDevice[] | undefined> {
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        pk: buildDeptScopedPk(toVerifiedDeptId({ deptId }), 'MEMBER', memberId),
        sk: 'METADATA',
      },
      ProjectionExpression: 'contactChannels',
      ConsistentRead: true,
    }),
  );
  if (!result.Item) {
    return undefined;
  }
  const entries = (result.Item.contactChannels as ContactChannelEntry[] | undefined) ?? [];
  return entries
    .filter((entry) => typeof entry?.channel === 'string' && entry.channel.toUpperCase() === 'PUSH')
    .map((entry) => ({
      deviceId: typeof entry.deviceId === 'string' ? entry.deviceId : null,
      platform: typeof entry.platform === 'string' ? entry.platform : null,
      registeredAt: typeof entry.registeredAt === 'number' ? entry.registeredAt : null,
      valid: entry.valid !== false,
    }))
    .sort((a, b) => (b.registeredAt ?? 0) - (a.registeredAt ?? 0));
}
