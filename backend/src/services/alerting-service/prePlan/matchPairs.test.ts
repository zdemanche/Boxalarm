import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { normalizeAddress } from './addressKey.js';
import { prePlanAddressPartition } from './copyKeys.js';
import { NO_HOME_LOCALITY, parseHomeLocality, type HomeLocality } from './locality.js';
import { findPrePlanByAddress } from './prePlanCopyRepository.js';

/**
 * The round-3 reviewer's adversarial pairs (__fixtures__/matchPairs.txt), run through the
 * real matcher. Each line: "DIFF|SAME | home | dispatch || copy ;; copy". The fake GSI1
 * indexes each copy under the consumer's own key (normalizeAddress with no extras, as
 * prePlanCopyHandler does). DIFF: different buildings — never an unflagged ADDRESS match.
 * SAME: the same building — always found (flagged or not).
 */
const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const HOMES: Record<string, HomeLocality> = {
  trumbull: parseHomeLocality({
    towns: ['Trumbull', 'Nichols', 'Long Hill', 'Trumbull Center'],
    zips: ['06611'],
    state: 'CT',
  })!,
  none: NO_HOME_LOCALITY,
  monroe: parseHomeLocality({
    towns: ['Monroe', 'Stepney', 'Upper Stepney'],
    zips: ['06468'],
    state: 'CT',
  })!,
  custom: parseHomeLocality({ towns: ['Trumbull', 'Plattsville'], zips: ['06611'], state: 'CT' })!,
};

function fakeIndex(copies: readonly string[]): DynamoDBDocumentClient {
  const items = copies.map((address, i) => {
    const key = normalizeAddress(address)?.key;
    return {
      entityType: 'PRE_PLAN_COPY',
      occupancyId: `occ${i}`,
      address,
      ...(key ? { gsi1pk: prePlanAddressPartition(DEPT_ID, key) } : {}),
    };
  });
  return {
    send: (command: { input: { ExpressionAttributeValues: Record<string, string> } }) =>
      Promise.resolve({
        Items: items.filter(
          (item) => item.gsi1pk === command.input.ExpressionAttributeValues[':gsi1pk'],
        ),
      }),
  } as unknown as DynamoDBDocumentClient;
}

const pairs = readFileSync(new URL('./__fixtures__/matchPairs.txt', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0 && !line.startsWith('//'))
  .map((line) => {
    const [expectation, home, rest] = line.split(' | ').map((part) => part.trim()) as [
      string,
      string,
      string,
    ];
    const [dispatch, copies] = rest.split(' || ') as [string, string];
    return {
      expectation,
      home,
      dispatch: dispatch.trim(),
      copies: copies.split(' ;; ').map((copy) => copy.trim()),
    };
  });

describe("round-3 reviewer's adversarial pairs through the real matcher", () => {
  it('loads the corpus', () => {
    expect(pairs.length).toBeGreaterThan(200);
  });

  it.each(pairs.filter((pair) => pair.expectation === 'DIFF'))(
    'DIFF ($home) $dispatch vs $copies: never an unflagged ADDRESS match',
    async ({ home, dispatch, copies }) => {
      const match = await findPrePlanByAddress(
        fakeIndex(copies),
        't',
        DEPT_ID,
        dispatch,
        undefined,
        HOMES[home]!,
      );
      expect(match?.matchType).not.toBe('ADDRESS');
    },
  );

  it.each(pairs.filter((pair) => pair.expectation === 'SAME'))(
    'SAME ($home) $dispatch vs $copies: the plan is found',
    async ({ home, dispatch, copies }) => {
      const match = await findPrePlanByAddress(
        fakeIndex(copies),
        't',
        DEPT_ID,
        dispatch,
        undefined,
        HOMES[home]!,
      );
      expect(match).toBeDefined();
    },
  );
});
