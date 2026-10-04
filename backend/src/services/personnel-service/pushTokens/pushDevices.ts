import { randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';

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
  const sorted = [...kept.filter(isPush), entry].sort(
    (a, b) => (b.registeredAt ?? 0) - (a.registeredAt ?? 0),
  );
  const devices = sorted.slice(0, MAX_PUSH_DEVICES);
  // An evicted device stops being paged: never silently (review MINOR-3).
  for (const evicted of sorted.slice(MAX_PUSH_DEVICES)) {
    console.warn(
      JSON.stringify({
        event: 'personnel.pushDevices.evicted',
        service: 'personnel-service',
        deviceId: evicted.deviceId ?? null,
        registeredAt: evicted.registeredAt ?? null,
        maxDevices: MAX_PUSH_DEVICES,
      }),
    );
    emitOutcomeMetric('Boxalarm/push-token', 'PushDeviceEvicted');
  }
  return [...kept.filter((existing) => !isPush(existing)), ...devices];
}

/** Removes only this device's entry (a legacy sign-out removes only the legacy entry). */
export function withoutDevice(
  current: readonly ContactChannelEntry[],
  deviceId: string | undefined,
): ContactChannelEntry[] {
  return current.filter((existing) => !isPush(existing) || !sameDevice(existing, deviceId));
}

/**
 * Another member's entry for the registering installation: the same push token. Never the
 * deviceId alone (review N-M1): the app's installation id could be copied to a second phone by an
 * iOS backup restore or Quick Start (older builds stored it migratable), and two members of one
 * department sharing it would take each other's pages away on every launch. A token is one app
 * install's, so it cannot collide; and an old entry whose token has since rotated is already dead
 * at APNs/FCM and cannot ring the phone. The deviceId still matches the member's OWN entries
 * (withRegisteredDevice).
 */
function holdsToken(entry: ContactChannelEntry, token: string): boolean {
  return isPush(entry) && entry.token === token;
}

/** Removes a registering installation's token from another member's devices. */
export function withoutToken(
  current: readonly ContactChannelEntry[],
  token: string,
): ContactChannelEntry[] {
  return current.filter((existing) => !holdsToken(existing, token));
}

/**
 * An installation belongs to the member signed in on it (M3). When member B registers a phone,
 * any other member of the department still holding its push token - A signed out with no signal,
 * so A's revoke never landed - has that entry removed, each through writePushDevices so their
 * personnel.member.updated reaches the alerting snapshot. Otherwise A's pages keep ringing, full
 * screen and through Do Not Disturb, on a phone A is no longer signed in to.
 *
 * Department-scoped (GSI3, every member of the department): a Cognito user is in one department.
 * Returns the members it was removed from.
 */
export async function releaseInstallationFromOtherMembers(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  installation: { readonly token: string },
  options: WritePushDevicesOptions = {},
): Promise<string[]> {
  const holders: string[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :gsi3pk',
        ExpressionAttributeValues: { ':gsi3pk': buildDeptScopedPk(deptId, 'MEMBER') },
        ProjectionExpression: 'memberId, contactChannels',
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const other = item.memberId as string | undefined;
      const channels = (item.contactChannels as ContactChannelEntry[] | undefined) ?? [];
      if (
        other &&
        other !== memberId &&
        channels.some((entry) => holdsToken(entry, installation.token))
      ) {
        holders.push(other);
      }
    }
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  for (const other of holders) {
    await writePushDevices(
      client,
      tableName,
      deptId,
      other,
      (current) => withoutToken(current, installation.token),
      options,
    );
  }
  return holders;
}

/** Removes every push device (device loss with no device identified). */
export function withoutAllDevices(current: readonly ContactChannelEntry[]): ContactChannelEntry[] {
  return current.filter((existing) => !isPush(existing));
}

export type PushDevicesWriteOutcome = 'written' | 'not_found';

export interface WritePushDevicesOptions {
  /** The outbox event's correlationId; defaults to the memberId. */
  readonly correlationId?: string;
  /**
   * Who made the change when it is not the member's own device - e.g. platform-service device
   * loss and the admin - carried on the event payload so it is not mistaken for the member's
   * own push-token revoke.
   */
  readonly changedBy?: Readonly<Record<string, unknown>>;
}

/**
 * Read, change, write the member's contact channels with the personnel.member.updated outbox
 * row in one transaction - guarded on the updatedAt that was read, so two devices registering
 * at once cannot drop each other's entry (the write that loses re-reads and retries). The event
 * time is max(now, previous updatedAt + 1): strictly after every earlier write to the row, so
 * the alerting projection (per-group clock) never discards it as stale - even two writes in one
 * millisecond. The ONLY writer of a member's push devices: registration, sign-out and
 * platform-service device loss all go through it.
 */
export async function writePushDevices(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  change: (current: readonly ContactChannelEntry[]) => ContactChannelEntry[],
  options: WritePushDevicesOptions = {},
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
                  correlationId: options.correlationId ?? memberId,
                  schemaVersion: '1.0',
                  payload: {
                    memberId,
                    deptId,
                    contactChannels,
                    ...(options.changedBy ? { changedBy: options.changedBy } : {}),
                  },
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
