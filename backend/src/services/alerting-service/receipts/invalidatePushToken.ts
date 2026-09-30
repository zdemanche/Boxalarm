import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { assertNoDelimiter, buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

interface ContactChannelSnapshot {
  readonly channel: string;
  readonly platform?: string;
  readonly token?: string;
  readonly valid?: boolean;
  readonly registeredAt?: number;
  readonly deviceId?: string;
}

/**
 * Webhook error codes that say the token itself is dead, so retrying the same token can never
 * succeed. Used by the provider-webhook path (pushReceiptHandler). The push worker classifies
 * the gateway's synchronous response itself (push/apnsAdapter.ts, push/fcmAdapter.ts).
 *
 * FCM `INVALID_ARGUMENT` is deliberately absent. It names a dead token only when its field
 * violation is `message.token`; otherwise it is a payload bug that must stay loud. A webhook
 * body carries just the code, so it cannot tell the two apart and must not disable a device
 * on it.
 */
export const PERMANENT_INVALID_TOKEN_CODES: ReadonlySet<string> = new Set([
  'BadDeviceToken',
  'Unregistered',
  'UNREGISTERED',
]);

export type InvalidatePushTokenResult = 'invalidated' | 'no_match' | 'reregistered';

const MAX_ATTEMPTS = 3;

/**
 * Marks the member's PUSH contact entry for `token` `valid: false` in the alerting eligibility
 * snapshot - one entry per device, and the member's other devices are untouched - but only
 * while that entry still exists: a device that re-registered a fresh token in the meantime must
 * not be disabled by a rejection of its old one, and neither must a device that re-registered
 * the same token after APNs last saw it invalid (the 410 race). Every other channel is
 * preserved. Guarded on the snapshot's contactVersion - the counter every contactChannels
 * writer advances (eligibility/contactProjection.ts) - so a concurrent token registration or
 * phone change is never overwritten; a lost race re-reads and retries.
 */
export async function invalidatePushToken(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  token: string,
  options: {
    /**
     * When the gateway last knew the token to be invalid (APNs 410 `timestamp`). An entry
     * registered at or after it was re-registered by a live device and is left alone.
     */
    readonly invalidSinceMs?: number;
    /**
     * Runs once, only when the entry is about to be invalidated (not for no_match or
     * reregistered), before the write. Throwing aborts the invalidation and the token stays
     * valid. The push worker's mass-invalidation guard hooks in here, so it counts only real
     * invalidations.
     */
    readonly beforeInvalidate?: () => Promise<void>;
  } = {},
): Promise<InvalidatePushTokenResult> {
  assertNoDelimiter(memberId, 'memberId');
  const pk = buildDeptScopedPk(deptId, 'ELIGIBILITY');
  const sk = `MEMBER#${memberId}`;

  let admitted = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const existing = await client.send(
      new GetCommand({ TableName: tableName, Key: { pk, sk }, ConsistentRead: true }),
    );
    const currentChannels =
      (existing.Item?.contactChannels as ContactChannelSnapshot[] | undefined) ?? [];
    // A member has one PUSH entry per device: the dead token is found among them, and only
    // its entry is invalidated - the member's other devices keep being paged.
    const isDeadEntry = (entry: ContactChannelSnapshot): boolean =>
      typeof entry?.channel === 'string' &&
      entry.channel.toUpperCase() === 'PUSH' &&
      entry.token === token;
    const pushEntry = currentChannels.find(isDeadEntry);
    if (!existing.Item || !pushEntry) {
      return 'no_match';
    }
    if (
      options.invalidSinceMs !== undefined &&
      typeof pushEntry.registeredAt === 'number' &&
      pushEntry.registeredAt >= options.invalidSinceMs
    ) {
      return 'reregistered';
    }

    if (!admitted) {
      await options.beforeInvalidate?.();
      admitted = true;
    }

    const version =
      typeof existing.Item.contactVersion === 'number' ? existing.Item.contactVersion : undefined;
    const contactChannels = currentChannels.map((entry) =>
      isDeadEntry(entry) ? { ...entry, valid: false } : entry,
    );

    try {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk, sk },
          UpdateExpression: 'SET contactChannels = :contactChannels, contactVersion = :nextVersion',
          ConditionExpression:
            version === undefined
              ? 'attribute_exists(pk) AND attribute_not_exists(contactVersion)'
              : 'attribute_exists(pk) AND contactVersion = :version',
          ExpressionAttributeValues: {
            ':contactChannels': contactChannels,
            ':nextVersion': (version ?? 0) + 1,
            ...(version === undefined ? {} : { ':version': version }),
          },
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        continue;
      }
      throw error;
    }
    return 'invalidated';
  }

  throw new Error(`push token invalidation for member ${memberId} lost a repeated write race`);
}
