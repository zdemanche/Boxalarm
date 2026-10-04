import { kvDelete, kvDeletePrefix, kvGet, kvSet } from './kvStore';

/**
 * Keys for a member's own cached data on this phone. There is no shared or anonymous variant: no
 * member id means nothing is cached (review m8). Cognito subs are unique across the user pool,
 * so they also separate departments.
 */
export const memberCacheKey = {
  read: (memberId: string, what: string) => `cache:${memberId}:${what}`,
  checkDraft: (memberId: string, unitId: string) => `check-draft:${memberId}:${unitId}`,
  lastMarkOff: (memberId: string) => `availability:last:${memberId}`,
  /** The self-test's "this phone last rang" (m6); `-` with no session. */
  lastSelfTest: (memberId: string | null) => `self-test-last:${memberId ?? '-'}`,
};

/** Before m6 the self-test record was per phone. */
const LEGACY_SELF_TEST_KEY = 'self-test-last';

/**
 * The member id of the session signed in on this phone, kept outside the keychain so an answer
 * queued while the keychain can't be read still knows who was signed in (R4-M1). Written on
 * sign-in and deleted on sign-out: a value that survived sign-out would let the next member's
 * token send a previous member's answer.
 */
export const LAST_SESSION_SUB_KEY = 'session:last-sub';

/**
 * Signing out removes the member's cached reads, checks in progress, last mark-off and their
 * answers to calls (the alert screen's "my answer", M1 - alertResponses.localAnswerPrefix).
 */
export async function clearMemberCache(memberId: string): Promise<void> {
  if (!memberId) return;
  await Promise.all([
    kvDeletePrefix(`cache:${memberId}:`),
    kvDeletePrefix(`check-draft:${memberId}:`),
    kvDeletePrefix(`availability:last:${memberId}`),
    kvDeletePrefix(`alert-answer:${memberId}:`),
    kvDelete(memberCacheKey.lastSelfTest(memberId)),
    kvDelete(LEGACY_SELF_TEST_KEY),
  ]);
}

/** The department whose calls the phone's alert caches hold. */
const CACHED_DEPT_KEY = 'session:cached-dept';

/**
 * A member of another department signing in must not see the previous department's calls from
 * the phone's alert caches (m6): the active-call list, recent pages, and each call's payload and
 * detail. Within one department they are shared data and are kept.
 */
export async function clearAlertCachesIfDeptChanged(deptId: string | null): Promise<void> {
  if (!deptId) return;
  const cached = (await kvGet<string>(CACHED_DEPT_KEY))?.value ?? null;
  if (cached !== null && cached !== deptId) {
    await Promise.all([
      kvDeletePrefix('active-dispatches'),
      kvDeletePrefix('recent-pages'),
      kvDeletePrefix('alert-payload:'),
      kvDeletePrefix('alert-detail:'),
    ]);
  }
  if (cached !== deptId) await kvSet(CACHED_DEPT_KEY, deptId);
}
