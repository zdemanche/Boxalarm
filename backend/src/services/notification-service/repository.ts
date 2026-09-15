import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export const CERT_EXPIRY_CATEGORY = 'cert-expiry';
export const TRAINING_OFFICER_DIGEST_CATEGORY = 'cert-expiry-officer';
export const TRAINING_OFFICER_ROLE = 'TRAINING';

const NOTIFICATION_TTL_SECONDS = 180 * 24 * 60 * 60;
const DIGEST_PENDING_TTL_SECONDS = 3 * 24 * 60 * 60;

export function TODAY_BUCKET(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface NotificationPreference {
  readonly memberId: string;
  readonly category: string;
  readonly muted: boolean;
  readonly updatedAt: number;
}

export interface PreferenceItem {
  readonly pk: string;
  readonly sk: string;
  readonly entityType: 'NOTIFICATION_PREFERENCE';
  readonly memberId: string;
  readonly category: string;
  readonly muted: boolean;
  readonly updatedAt: number;
}

export function buildPreferenceItem(
  deptId: VerifiedDeptId,
  memberId: string,
  category: string,
  muted: boolean,
  updatedAt: number,
): PreferenceItem {
  return {
    pk: buildDeptScopedPk(deptId, 'MEMBER', memberId),
    sk: `NOTIFPREF#${memberId}#${category}`,
    entityType: 'NOTIFICATION_PREFERENCE',
    memberId,
    category,
    muted,
    updatedAt,
  };
}

export function parsePreferenceItem(
  item: Record<string, unknown> | undefined,
): NotificationPreference | undefined {
  if (!item) {
    return undefined;
  }
  return {
    memberId: item.memberId as string,
    category: item.category as string,
    muted: item.muted as boolean,
    updatedAt: item.updatedAt as number,
  };
}

export interface DigestNotificationItem {
  readonly certId: string;
  readonly expiryDate: string;
}

export interface NotificationItem {
  readonly pk: string;
  readonly sk: string;
  readonly entityType: 'NOTIFICATION';
  readonly notificationId: string;
  readonly memberId: string;
  readonly category: string;
  readonly items: readonly DigestNotificationItem[];
  readonly summary: string;
  readonly createdAt: number;
  readonly readAt: number | null;
  readonly ttl: number;
}

export function buildNotificationItem(
  deptId: VerifiedDeptId,
  memberId: string,
  notificationId: string,
  category: string,
  items: readonly DigestNotificationItem[],
  createdAt: number,
): NotificationItem {
  return {
    pk: buildDeptScopedPk(deptId, 'MEMBER', memberId),
    sk: `NOTIF#${memberId}#${createdAt}#${notificationId}`,
    entityType: 'NOTIFICATION',
    notificationId,
    memberId,
    category,
    items,
    summary: `${items.length} item${items.length === 1 ? '' : 's'} expiring`,
    createdAt,
    readAt: null,
    ttl: Math.floor(createdAt / 1000) + NOTIFICATION_TTL_SECONDS,
  };
}

export type PendingRecipientType = 'MEMBER' | 'ROLE';

export interface PendingItem {
  readonly pk: string;
  readonly sk: string;
  readonly entityType: 'DIGEST_PENDING';
  readonly recipientType: PendingRecipientType;
  readonly recipientId: string;
  readonly category: string;
  readonly certId: string;
  readonly expiryDate: string;
  readonly gsi3pk: string;
  readonly gsi3sk: string;
  readonly ttl: number;
}

export function buildPendingItem(
  deptId: VerifiedDeptId,
  recipientType: PendingRecipientType,
  recipientId: string,
  category: string,
  certId: string,
  expiryDate: string,
  today: string,
  now: number,
  uniqueSuffix?: string,
): PendingItem {
  const skSuffix = uniqueSuffix ? `${certId}#${uniqueSuffix}` : certId;
  return {
    pk: buildDeptScopedPk(deptId, recipientType, recipientId),
    sk: `DIGEST_PENDING#${category}#${today}#${skSuffix}`,
    entityType: 'DIGEST_PENDING',
    recipientType,
    recipientId,
    category,
    certId,
    expiryDate,
    gsi3pk: buildDeptScopedPk(deptId, 'DIGEST_PENDING', today),
    gsi3sk: `${recipientType}#${recipientId}#${skSuffix}`,
    ttl: Math.floor(now / 1000) + DIGEST_PENDING_TTL_SECONDS,
  };
}

export interface DigestSentMarker {
  readonly pk: string;
  readonly sk: string;
  readonly entityType: 'DIGEST_SENT';
  readonly ttl: number;
}

export function buildDigestSentMarker(
  deptId: VerifiedDeptId,
  recipientType: PendingRecipientType,
  recipientId: string,
  category: string,
  today: string,
  now: number,
): DigestSentMarker {
  return {
    pk: buildDeptScopedPk(deptId, recipientType, recipientId),
    sk: `DIGESTSENT#${category}#${today}`,
    entityType: 'DIGEST_SENT',
    ttl: Math.floor(now / 1000) + DIGEST_PENDING_TTL_SECONDS,
  };
}

export interface TransactCancellationError {
  readonly name: string;
  readonly CancellationReasons?: ReadonlyArray<{ readonly Code?: string }>;
}

export function asTransactionCancellation(error: unknown): TransactCancellationError | undefined {
  return error instanceof Error && error.name === 'TransactionCanceledException'
    ? error
    : undefined;
}

export function isConditionalCheckFailed(error: unknown): boolean {
  const cancellation = asTransactionCancellation(error);
  return (cancellation?.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed');
}
