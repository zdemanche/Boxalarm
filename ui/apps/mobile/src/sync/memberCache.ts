import { kvDeletePrefix } from './kvStore';

/**
 * Keys for a member's own cached data on this phone. There is no shared or anonymous variant: no
 * member id means nothing is cached (review m8). Cognito subs are unique across the user pool,
 * so they also separate departments.
 */
export const memberCacheKey = {
  read: (memberId: string, what: string) => `cache:${memberId}:${what}`,
  checkDraft: (memberId: string, unitId: string) => `check-draft:${memberId}:${unitId}`,
  lastMarkOff: (memberId: string) => `availability:last:${memberId}`,
};

/** Signing out removes the member's cached reads, checks in progress and last mark-off. */
export async function clearMemberCache(memberId: string): Promise<void> {
  if (!memberId) return;
  await Promise.all([
    kvDeletePrefix(`cache:${memberId}:`),
    kvDeletePrefix(`check-draft:${memberId}:`),
    kvDeletePrefix(`availability:last:${memberId}`),
  ]);
}
