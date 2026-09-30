import { kvGet, kvSet } from './kvStore';
import { clearMemberCache, memberCacheKey } from './memberCache';

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
