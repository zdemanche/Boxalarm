import { randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

/**
 * A member's push devices. Each signed-in app installation registers its own PUSH entry,
 * keyed by `deviceId` (the installation id the app generates and keeps), so signing in on a
 * tablet no longer replaces - and silently stops paging - the member's phone.
 *
 * Entries written before multi-device support, and registrations from app builds that send
 * no deviceId, carry none; they behave as before: one such legacy entry per member, replaced
 * by the next legacy registration and removed by a legacy sign-out, and never disturbing the
 * entries of devices that do identify themselves.
 */

export interface ContactChannelEntry {
  readonly channel: string;
  readonly platform?: string;
  readonly token?: string;
  readonly valid?: boolean;
  readonly registeredAt?: number;
  readonly deviceId?: string;
  /**
   * iOS: the APNs environment the app build is signed for - `development` (Xcode) or
   * `production` (TestFlight / App Store). The push worker sends on that environment's host;
   * an entry without it is production.
   */
  readonly apnsEnvironment?: 'development' | 'production';
}

/** Bounds the fan to one member's devices; the oldest registration is dropped past it. */
export const MAX_PUSH_DEVICES = 10;

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_WRITE_ATTEMPTS = 3;

/** undefined when absent; throws on a present but unusable value. */
export function parseDeviceId(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || !DEVICE_ID_PATTERN.test(value)) {
    throw new Error('deviceId must be 1-128 characters of letters, digits, ".", "_", ":" or "-"');
  }
  return value;
}

function isPush(entry: ContactChannelEntry): boolean {
  return typeof entry?.channel === 'string' && entry.channel.toUpperCase() === 'PUSH';
}

/** The same installation: equal deviceIds, or (legacy) both without one. */
function sameDevice(entry: ContactChannelEntry, deviceId: string | undefined): boolean {
  return deviceId === undefined ? entry.deviceId === undefined : entry.deviceId === deviceId;
}

/**
 * Adds or rotates this device's entry. A token is one device's, so any other entry holding the
 * same token (an app that just started sending its deviceId) is replaced too.
 */
export function withRegisteredDevice(
  current: readonly ContactChannelEntry[],
  entry: ContactChannelEntry & { readonly token: string },
): ContactChannelEntry[] {
  const kept = current.filter(
    (existing) =>
      !isPush(existing) ||
      !(sameDevice(existing, entry.deviceId) || existing.token === entry.token),
  );
  const devices = [...kept.filter(isPush), entry]
    .sort((a, b) => (b.registeredAt ?? 0) - (a.registeredAt ?? 0))
    .slice(0, MAX_PUSH_DEVICES);
  return [...kept.filter((existing) => !isPush(existing)), ...devices];
}

/** Removes only this device's entry (a legacy sign-out removes only the legacy entry). */
export function withoutDevice(
  current: readonly ContactChannelEntry[],
  deviceId: string | undefined,
): ContactChannelEntry[] {
  return current.filter((existing) => !isPush(existing) || !sameDevice(existing, deviceId));
}

export type PushDevicesWriteOutcome = 'written' | 'not_found';

/**
 * Read, change, write the member's contact channels with the personnel.member.updated outbox
 * row in one transaction - guarded on the updatedAt that was read, so two devices registering
 * at once cannot drop each other's entry (the write that loses re-reads and retries).
 */
export async function writePushDevices(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  change: (current: readonly ContactChannelEntry[]) => ContactChannelEntry[],
): Promise<PushDevicesWriteOutcome> {
  const pk = buildDeptScopedPk(deptId, 'MEMBER', memberId);
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const existing = await client.send(
      new GetCommand({ TableName: tableName, Key: { pk, sk: 'METADATA' }, ConsistentRead: true }),
    );
    if (!existing.Item) {
      return 'not_found';
    }
    const current = (existing.Item.contactChannels as ContactChannelEntry[] | undefined) ?? [];
    const contactChannels = change(current);
    const previousUpdatedAt = existing.Item.updatedAt as number | undefined;
    const now = Math.max(Date.now(), (previousUpdatedAt ?? 0) + 1);
    const eventId = randomUUID();

    try {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName,
                Key: { pk, sk: 'METADATA' },
                ConditionExpression:
                  previousUpdatedAt === undefined
                    ? 'attribute_exists(pk) AND attribute_not_exists(updatedAt)'
                    : 'attribute_exists(pk) AND updatedAt = :previousUpdatedAt',
                UpdateExpression: 'SET contactChannels = :cc, updatedAt = :ts',
                ExpressionAttributeValues: {
                  ':cc': contactChannels,
                  ':ts': now,
                  ...(previousUpdatedAt === undefined
                    ? {}
                    : { ':previousUpdatedAt': previousUpdatedAt }),
                },
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: {
                  pk: buildDeptScopedPk(deptId, 'OUTBOX', memberId),
                  sk: `EVT#${eventId}`,
                  entityType: 'OUTBOX_ENTRY',
                  eventId,
                  eventTime: new Date(now).toISOString(),
                  eventType: 'personnel.member.updated',
                  source: 'personnel-service',
                  correlationId: memberId,
                  schemaVersion: '1.0',
                  payload: { memberId, deptId, contactChannels },
                  sentAt: null,
                },
              },
            },
          ],
        }),
      );
      return 'written';
    } catch (error) {
      const lostRace =
        error instanceof TransactionCanceledException &&
        error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
      if (!lostRace) {
        throw error;
      }
    }
  }
  throw new Error(`push device write for member ${memberId} lost a repeated write race`);
}
