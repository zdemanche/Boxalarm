import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { normalizePhoneE164 } from './phone.js';
import type { ContactChannelSnapshot } from './resolvePushTarget.js';

/**
 * How the alerting-owned `personnel.member.updated` consumer maintains the eligibility
 * snapshot's `contactChannels` — the list every producer (fan-out, tone evaluator, mutual aid)
 * and the channel worker resolve targets from (resolvePushTarget.ts / channelEnvelope.ts).
 *
 * The list has two groups with two different sources, each replaced only by its own source:
 *  - device entries (`channel: 'PUSH'`) come from the event's `contactChannels`, which the push
 *    token routes copy from the member record (registerToken.ts / revokeToken.ts);
 *  - phone entries (`SMS` and `VOICE`) are projected here from the event's `phone`, which member
 *    creation and profile edits carry (memberRepository.createMember, updateMember.ts). Nothing
 *    on the LOB side writes SMS/VOICE entries, and before this projection existed nothing
 *    anywhere did: every SMS page and voice escalation found no target (design review C2).
 *
 * Each group carries its own timestamp (pushContactsUpdatedAt, phoneUpdatedAt), so a newer
 * event for one group never makes the other group's event stale, and the list itself is
 * written under an optimistic `contactVersion` check, so two concurrent group updates (or a
 * push-token invalidation, receipts/invalidatePushToken.ts) never overwrite each other.
 */

export const PUSH_CHANNEL = 'PUSH';
export const SMS_CHANNEL = 'SMS';
export const VOICE_CHANNEL = 'VOICE';

const MAX_ATTEMPTS = 3;

export interface ContactUpdate {
  /** Device entries from the event's contactChannels; non-PUSH entries in it are ignored. */
  readonly pushEntries?: readonly ContactChannelSnapshot[];
  /** The member's phone; projected into one SMS and one VOICE entry. */
  readonly phone?: string;
}

export type ContactUpdateOutcome = 'applied' | 'stale';

function isPushEntry(entry: unknown): boolean {
  const channel = (entry as { channel?: unknown } | null)?.channel;
  return typeof channel === 'string' && channel.toUpperCase() === PUSH_CHANNEL;
}

/**
 * The SMS and VOICE entries for a phone, in exactly the shape both sides read: findContactEntry
 * matches `channel` case-insensitively and skips `valid: false`; contactPhone reads
 * `phoneNumber`. Voice dials the same number (channelEnvelope.resolveChannelTarget).
 */
export function phoneContactEntries(phone: string): ContactChannelSnapshot[] {
  // Callers pass E.164 (memberUpdatedHandler normalises); anything else is not a sendable
  // target and yields no entries rather than a page the vendor refuses.
  const e164 = normalizePhoneE164(phone);
  if (!e164) {
    return [];
  }
  phone = e164;
  return [
    { channel: SMS_CHANNEL, phoneNumber: phone, valid: true },
    { channel: VOICE_CHANNEL, phoneNumber: phone, valid: true },
  ];
}

/** Device entries from an event's contactChannels: PUSH only, malformed entries dropped. */
export function pushEntriesFrom(contactChannels: readonly unknown[]): ContactChannelSnapshot[] {
  return contactChannels.filter(isPushEntry) as ContactChannelSnapshot[];
}

export function mergeContactChannels(
  existing: readonly unknown[],
  update: { readonly pushEntries?: readonly unknown[]; readonly phoneEntries?: readonly unknown[] },
): unknown[] {
  const currentPush = existing.filter(isPushEntry);
  const currentPhone = existing.filter((entry) => !isPushEntry(entry));
  return [...(update.pushEntries ?? currentPush), ...(update.phoneEntries ?? currentPhone)];
}

function isNewer(stored: unknown, eventTimeMs: number): boolean {
  return typeof stored !== 'number' || stored < eventTimeMs;
}

/**
 * Applies the contact groups this event carries, each only when the event is newer than that
 * group's last update. Read, merge, then write guarded on the contactVersion that was read; a
 * lost race re-reads and retries. Returns 'stale' when every carried group is older than what
 * is stored (a redelivered or out-of-order event), which is not an error.
 */
export async function applyContactUpdate(
  client: DynamoDBDocumentClient,
  tableName: string,
  key: { readonly pk: string; readonly sk: string },
  memberId: string,
  update: ContactUpdate,
  eventTimeMs: number,
): Promise<ContactUpdateOutcome> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const { Item } = await client.send(
      new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
    );
    const applyPush =
      update.pushEntries !== undefined && isNewer(Item?.pushContactsUpdatedAt, eventTimeMs);
    const applyPhone = update.phone !== undefined && isNewer(Item?.phoneUpdatedAt, eventTimeMs);
    if (!applyPush && !applyPhone) {
      return 'stale';
    }

    const existing = Array.isArray(Item?.contactChannels)
      ? (Item.contactChannels as unknown[])
      : [];
    const contactChannels = mergeContactChannels(existing, {
      ...(applyPush ? { pushEntries: update.pushEntries } : {}),
      ...(applyPhone && update.phone !== undefined
        ? { phoneEntries: phoneContactEntries(update.phone) }
        : {}),
    });
    const version = typeof Item?.contactVersion === 'number' ? Item.contactVersion : undefined;

    const setClauses = [
      'entityType = :entityType',
      'memberId = :memberId',
      'contactChannels = :contactChannels',
      'contactVersion = :nextVersion',
      // Seeded only, so a first-ever event (a new member) yields a snapshot the selector
      // accepts, and a contact change never overwrites eligibility fields or moves
      // snapshotUpdatedAt (which the availability consumer guards on).
      'snapshotUpdatedAt = if_not_exists(snapshotUpdatedAt, :eventTime)',
      'active = if_not_exists(active, :defaultActive)',
      'availabilityState = if_not_exists(availabilityState, :defaultAvailability)',
      'quals = if_not_exists(quals, :emptyList)',
      '#roles = if_not_exists(#roles, :emptyList)',
      ...(applyPush ? ['pushContactsUpdatedAt = :eventTime'] : []),
      ...(applyPhone ? ['phoneUpdatedAt = :eventTime'] : []),
    ];

    try {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: key,
          UpdateExpression: `SET ${setClauses.join(', ')}`,
          ConditionExpression:
            version === undefined
              ? 'attribute_not_exists(contactVersion)'
              : 'contactVersion = :version',
          // `roles` is a DynamoDB reserved word.
          ExpressionAttributeNames: { '#roles': 'roles' },
          ExpressionAttributeValues: {
            ':entityType': 'MEMBER_ELIGIBILITY_SNAPSHOT',
            ':memberId': memberId,
            ':contactChannels': contactChannels,
            ':nextVersion': (version ?? 0) + 1,
            ':eventTime': eventTimeMs,
            ':defaultActive': true,
            ':defaultAvailability': 'AVAILABLE',
            ':emptyList': [],
            ...(version === undefined ? {} : { ':version': version }),
          },
        }),
      );
      return 'applied';
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`contact update for member ${memberId} lost a repeated write race`);
}
