import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { normalizeAddress } from './addressKey.js';
import {
  NO_HOME_LOCALITY,
  judgeLocality,
  loadHomeLocality,
  parseHomeLocality,
} from './locality.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const HOME = parseHomeLocality({
  towns: ['Trumbull', 'Nichols', 'Long Hill', 'Trumbull Center'],
  zips: ['06611'],
  state: 'CT',
})!;

const judge = (dispatch: string, copy: string, home = HOME) =>
  judgeLocality(normalizeAddress(dispatch)!, normalizeAddress(copy)!, home);

describe('parseHomeLocality', () => {
  it('normalizes names the way addresses are compared and keeps only 5-digit ZIPs', () => {
    const home = parseHomeLocality({ towns: ['North Haven', ' long hill '], zips: ['06611', 'x'] });
    expect([...(home?.towns ?? [])]).toEqual(['N HAVEN', 'LONG HILL']);
    expect([...(home?.zips ?? [])]).toEqual(['06611']);
  });

  it('is undefined for an empty or malformed config', () => {
    expect(parseHomeLocality({ towns: [], zips: [] })).toBeUndefined();
    expect(parseHomeLocality('Trumbull')).toBeUndefined();
    expect(parseHomeLocality(undefined)).toBeUndefined();
  });
});

describe('judgeLocality', () => {
  it.each([
    // R3-A: a dispatch naming no locality is never verified.
    ['123 Main St', '123 Main St', 'UNVERIFIED'],
    ['123 Main St, Trumbull, CT', '123 Main St', 'VERIFIED'],
    ['123 Main St, Nichols, CT', '123 Main St, Trumbull, CT', 'VERIFIED'],
    ['123 Main St, CT 06611', '123 Main St', 'VERIFIED'],
    ['123 Main St, Bridgeport, CT', '123 Main St', 'REJECT'],
    ['123 Main St, CT 06604', '123 Main St', 'REJECT'],
    ['123 Main St, Springfield, MA', '123 Main St', 'REJECT'],
    ['123 Main St, Bridgeport, CT', '123 Main St, Trumbull, CT', 'REJECT'],
    ['123 Main St', '123 Main St, Monroe, CT', 'UNVERIFIED'],
    ['123 Main St, Monroe, CT', '123 Main St, Monroe, CT', 'VERIFIED'],
    // A village outside the home set, but the ZIP agrees: shown, flagged.
    ['123 Main St, Stepney, CT 06611', '123 Main St', 'UNVERIFIED'],
  ] as const)('%s vs copy %s -> %s', (dispatch, copy, verdict) => {
    expect(judge(dispatch, copy)).toBe(verdict);
  });

  describe('R3-B: a partly-localized home copy inherits the rest of the home set', () => {
    it.each([
      ['12 Main St, Bridgeport, CT 06611', '12 Main St 06611'],
      ['12 Main St, Stratford, CT 06611', '12 Main St, CT 06611'],
      ['12 Main St, Bridgeport, 06611', '12 Main St, CT'],
      ['12 Main St, Monroe, CT 06611', '12 Main St, Trumbull'],
      ['12 Main St, Trumbull, CT 06606', '12 Main St, Nichols'],
      ['12 Main St, Trumbull, CT 06606', '12 Main St, 06611'],
    ] as const)('%s vs copy %s is never VERIFIED', (dispatch, copy) => {
      expect(judge(dispatch, copy)).not.toBe('VERIFIED');
    });

    it('is judged exactly like a fully town-less copy', () => {
      for (const dispatch of [
        '12 Main St, Bridgeport, CT 06611',
        '12 Main St, Trumbull, CT 06606',
        '12 Main St, Nichols, CT 06611',
      ]) {
        expect(judge(dispatch, '12 Main St 06611'), dispatch).toBe(judge(dispatch, '12 Main St'));
        expect(judge(dispatch, '12 Main St, Nichols'), dispatch).toBe(
          judge(dispatch, '12 Main St'),
        );
      }
    });

    it('still verifies genuine agreement', () => {
      expect(judge('12 Main St, Trumbull, CT 06611', '12 Main St 06611')).toBe('VERIFIED');
      expect(judge('12 Main St, Nichols, CT 06611', '12 Main St, Trumbull, CT 06611')).toBe(
        'VERIFIED',
      );
    });
  });

  it('verifies nothing when no home locality is configured', () => {
    expect(judge('123 Main St', '123 Main St', NO_HOME_LOCALITY)).toBe('UNVERIFIED');
    expect(judge('123 Main St, Trumbull, CT', '123 Main St', NO_HOME_LOCALITY)).toBe('UNVERIFIED');
    // A positive conflict still rejects.
    expect(
      judge('123 Main St, Bridgeport, CT', '123 Main St, Trumbull, CT', NO_HOME_LOCALITY),
    ).toBe('REJECT');
  });

  it('never verifies an ambiguously parsed address', () => {
    const dispatch = { ...normalizeAddress('123 Main St')!, ambiguous: true };
    expect(judgeLocality(dispatch, normalizeAddress('123 Main St')!, HOME)).toBe('UNVERIFIED');
  });
});

describe('loadHomeLocality', () => {
  const client = (send: ReturnType<typeof vi.fn>) =>
    ({ send }) as unknown as DynamoDBDocumentClient;

  it('prefers the department config item in the alerting table', async () => {
    const send = vi.fn().mockResolvedValue({ Item: { towns: ['Monroe'], zips: ['06468'] } });
    const home = await loadHomeLocality(client(send), 'alerting', DEPT_ID, {
      ALERTING_HOME_LOCALITY: JSON.stringify({ towns: ['Trumbull'] }),
    });
    expect([...home.towns]).toEqual(['MONROE']);
    expect((send.mock.calls[0]?.[0] as { input: { Key: unknown } }).input.Key).toEqual({
      pk: 'DEPT#NICHOLS#CONFIG',
      sk: 'HOME_LOCALITY',
    });
  });

  it('falls back to the stack default in ALERTING_HOME_LOCALITY', async () => {
    const send = vi.fn().mockResolvedValue({});
    const home = await loadHomeLocality(client(send), 'alerting', DEPT_ID, {
      ALERTING_HOME_LOCALITY: JSON.stringify({ towns: ['Trumbull'], zips: ['06611'] }),
    });
    expect([...home.towns]).toEqual(['TRUMBULL']);
  });

  it('degrades to "unverifiable" (never throws) when the read fails and nothing is set', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn().mockRejectedValue(new Error('throttled'));
    expect(await loadHomeLocality(client(send), 'alerting', DEPT_ID, {})).toBe(NO_HOME_LOCALITY);
    errorSpy.mockRestore();
  });
});
