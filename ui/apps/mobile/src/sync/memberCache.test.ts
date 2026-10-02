import { kvGet, kvSet } from './kvStore';
import { clearAlertCachesIfDeptChanged, clearMemberCache, memberCacheKey } from './memberCache';

test("sign-out clearing removes only that member's cache, drafts and last mark-off", async () => {
  await kvSet(memberCacheKey.read('m-1', 'apparatus'), ['E1']);
  await kvSet(memberCacheKey.checkDraft('m-1', 'E1'), { results: {} });
  await kvSet(memberCacheKey.lastMarkOff('m-1'), { endAt: 'x' });
  await kvSet(memberCacheKey.read('m-2', 'apparatus'), ['E2']);

  await clearMemberCache('m-1');

  expect(await kvGet(memberCacheKey.read('m-1', 'apparatus'))).toBeNull();
  expect(await kvGet(memberCacheKey.checkDraft('m-1', 'E1'))).toBeNull();
  expect(await kvGet(memberCacheKey.lastMarkOff('m-1'))).toBeNull();
  expect((await kvGet(memberCacheKey.read('m-2', 'apparatus')))?.value).toEqual(['E2']);
});

test("m6: sign-out removes the member's self-test record (and the old per-phone one)", async () => {
  await kvSet(memberCacheKey.lastSelfTest('m-1'), { rang: 'yes' });
  await kvSet('self-test-last', { rang: 'yes' });
  await kvSet(memberCacheKey.lastSelfTest('m-2'), { rang: 'yes' });

  await clearMemberCache('m-1');

  expect(await kvGet(memberCacheKey.lastSelfTest('m-1'))).toBeNull();
  expect(await kvGet('self-test-last')).toBeNull();
  expect(await kvGet(memberCacheKey.lastSelfTest('m-2'))).not.toBeNull();
});

test("m6: another department signing in does not see the previous department's calls", async () => {
  await clearAlertCachesIfDeptChanged('DEPT-A');
  await kvSet('active-dispatches', ['D-1']);
  await kvSet('alert-payload:D-1', { dispatchId: 'D-1' });
  await kvSet('alert-detail:D-1', { dispatchId: 'D-1' });
  await kvSet('recent-pages', ['D-1']);

  await clearAlertCachesIfDeptChanged('DEPT-A');
  expect(await kvGet('active-dispatches')).not.toBeNull();

  await clearAlertCachesIfDeptChanged('DEPT-B');
  for (const key of [
    'active-dispatches',
    'alert-payload:D-1',
    'alert-detail:D-1',
    'recent-pages',
  ]) {
    expect(await kvGet(key)).toBeNull();
  }
});
