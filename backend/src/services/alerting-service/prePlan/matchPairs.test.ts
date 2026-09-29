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
 * real matcher. Each line: "LABEL | home | dispatch || copy ;; copy [## reason]" (labels are
 * explained at the top of the fixture). The fake GSI1 indexes each copy under the consumer's
 * own key (normalizeAddress with no extras, as prePlanCopyHandler does). Every row runs twice:
 * with no locality choice, and with the home set's town as the dispatcher's HOME choice (the
 * production path since R3-A, round-4 m5).
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
  // Towns but no ZIPs (round-4b n1).
  townsonly: parseHomeLocality({ towns: ['Trumbull', 'Nichols'], state: 'CT' })!,
};

/** The dispatcher's HOME choice per home set ('none' has no home list: typed as Other). */
const HOME_CHOICE: Record<string, string> = {
  trumbull: 'Trumbull',
  none: 'Trumbull',
  monroe: 'Monroe',
  custom: 'Trumbull',
  townsonly: 'Trumbull',
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
    const [row = '', reason = ''] = line.split(' ## ');
    const [expectation, home, rest] = row.split(' | ').map((part) => part.trim()) as [
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
      reason: reason.trim(),
    };
  });

const LOCALITY = ['no choice', 'HOME choice'] as const;

function lookup(
  pair: (typeof pairs)[number],
  locality: (typeof LOCALITY)[number],
): ReturnType<typeof findPrePlanByAddress> {
  return findPrePlanByAddress(
    fakeIndex(pair.copies),
    't',
    DEPT_ID,
    pair.dispatch,
    undefined,
    HOMES[pair.home]!,
    locality === 'HOME choice' ? { town: HOME_CHOICE[pair.home]! } : undefined,
  );
}

const rows = (label: string) =>
  pairs
    .filter((pair) => pair.expectation === label)
    .flatMap((pair) => LOCALITY.map((locality) => ({ ...pair, locality })));

describe("round-3 reviewer's adversarial pairs through the real matcher", () => {
  it('loads the corpus, with only known labels', () => {
    expect(pairs.length).toBeGreaterThan(200);
    for (const pair of pairs) {
      expect(['DIFF', 'SAME', 'UNPLACED', 'KNOWN_COLLISION']).toContain(pair.expectation);
      expect(Object.keys(HOMES)).toContain(pair.home);
    }
  });

  it.each(rows('DIFF'))(
    'DIFF ($home, $locality) $dispatch vs $copies: never an unflagged ADDRESS match',
    async (pair) => {
      expect((await lookup(pair, pair.locality))?.matchType).not.toBe('ADDRESS');
    },
  );

  it.each(rows('SAME'))(
    'SAME ($home, $locality) $dispatch vs $copies: the plan found is occ0',
    async (pair) => {
      const match = await lookup(pair, pair.locality);
      expect(match && 'copy' in match ? match.copy.occupancyId : match?.matchType).toBe('occ0');
    },
  );

  it.each(rows('UNPLACED'))(
    'UNPLACED ($home, $locality) $dispatch vs $copies: verified only with the HOME choice',
    async (pair) => {
      const match = await lookup(pair, pair.locality);
      if (pair.locality === 'no choice') {
        expect(match?.matchType).not.toBe('ADDRESS');
      } else {
        expect(match).toMatchObject({ matchType: 'ADDRESS', copy: { occupancyId: 'occ0' } });
      }
    },
  );

  it.each(rows('KNOWN_COLLISION'))(
    'KNOWN_COLLISION ($home, $locality) $dispatch vs $copies: accepted because $reason',
    async (pair) => {
      expect(pair.reason.length).toBeGreaterThan(0);
      const match = await lookup(pair, pair.locality);
      // Still a collision: once the matcher splits it, relabel the row DIFF.
      expect(match?.matchType).toBe(
        pair.locality === 'HOME choice' ? 'ADDRESS' : 'ADDRESS_UNVERIFIED',
      );
    },
  );
});
