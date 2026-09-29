import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { normalizeAddress } from './addressKey.js';
import {
  NO_HOME_LOCALITY,
  homeTownsThatAreTowns,
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

  describe('m3: a towns-only home set (no home ZIPs) does not let a ZIP alone verify', () => {
    const TOWNS_ONLY = parseHomeLocality({ towns: ['Trumbull', 'Nichols'], state: 'CT' })!;

    it.each([
      ['12 Main St, Bridgeport, CT 06611', '12 Main St 06611'],
      ['12 Main St, Bridgeport 06611', '12 Main St, CT 06611'],
      ['12 Main St, Trumbull, CT 06606', '12 Main St 06611'],
    ] as const)('%s vs copy %s is never VERIFIED', (dispatch, copy) => {
      expect(judge(dispatch, copy, TOWNS_ONLY)).not.toBe('VERIFIED');
    });

    it('still verifies a home-town dispatch against a ZIP-only (town-less, so home) copy', () => {
      expect(judge('12 Main St, Trumbull, CT 06611', '12 Main St 06611', TOWNS_ONLY)).toBe(
        'VERIFIED',
      );
      expect(judge('12 Main St, Nichols', '12 Main St 06611', TOWNS_ONLY)).toBe('VERIFIED');
    });

    it('a ZIP-only copy outside configured home ZIPs cannot confirm a dispatch town', () => {
      expect(judge('12 Main St, Bridgeport, CT 06606', '12 Main St 06606')).toBe('UNVERIFIED');
      expect(judge('12 Main St, Trumbull, CT 06606', '12 Main St 06606')).toBe('UNVERIFIED');
      // With no town named on the dispatch, the explicit ZIP agreement still stands.
      expect(judge('12 Main St 06606', '12 Main St 06606')).toBe('VERIFIED');
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
      ALERTING_HOME_LOCALITY: JSON.stringify({ deptId: 'NICHOLS', towns: ['Trumbull'] }),
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
      ALERTING_HOME_LOCALITY: JSON.stringify({
        deptId: 'NICHOLS',
        towns: ['Trumbull'],
        zips: ['06611'],
      }),
    });
    expect([...home.towns]).toEqual(['TRUMBULL']);
  });

  it('minor 2: the stack default applies only to the department it names', async () => {
    const send = vi.fn().mockResolvedValue({});
    const env = {
      ALERTING_HOME_LOCALITY: JSON.stringify({ deptId: 'OTHERFD', towns: ['Trumbull'] }),
    };
    expect(await loadHomeLocality(client(send), 'alerting', DEPT_ID, env)).toBe(NO_HOME_LOCALITY);
    const unlabelled = { ALERTING_HOME_LOCALITY: JSON.stringify({ towns: ['Trumbull'] }) };
    expect(await loadHomeLocality(client(send), 'alerting', DEPT_ID, unlabelled)).toBe(
      NO_HOME_LOCALITY,
    );
  });

  it('degrades to "unverifiable" (never throws) when the read fails and nothing is set', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn().mockRejectedValue(new Error('throttled'));
    expect(await loadHomeLocality(client(send), 'alerting', DEPT_ID, {})).toBe(NO_HOME_LOCALITY);
    errorSpy.mockRestore();
  });

  describe('minor 3: an unusable or missing home set is logged and counted', () => {
    const run = async (
      item: unknown,
      env: NodeJS.ProcessEnv,
      purpose: 'dispatch' | 'form' = 'dispatch',
    ) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const send = vi.fn().mockResolvedValue(item === undefined ? {} : { Item: item });
      const home = await loadHomeLocality(client(send), 'alerting', DEPT_ID, env, purpose);
      const errors = errorSpy.mock.calls.join('\n');
      const metrics = logSpy.mock.calls.join('\n');
      errorSpy.mockRestore();
      logSpy.mockRestore();
      return { home, errors, metrics };
    };

    it('an unparseable HOME_LOCALITY item', async () => {
      const { home, errors, metrics } = await run(
        { towns: 'Trumbull' },
        { ALERTING_HOME_LOCALITY: JSON.stringify({ deptId: 'NICHOLS', towns: ['Trumbull'] }) },
      );
      expect([...home.towns]).toEqual(['TRUMBULL']);
      expect(errors).toContain('preplan_copy.home_locality_invalid');
      expect(metrics).toContain('HomeLocalityInvalid');
    });

    it('an unparseable env default', async () => {
      const { errors, metrics } = await run(undefined, { ALERTING_HOME_LOCALITY: '{not json' });
      expect(errors).toContain('preplan_copy.home_locality_invalid');
      expect(metrics).toContain('HomeLocalityInvalid');
    });

    it('a dispatch served with no home set at all', async () => {
      const { home, errors, metrics } = await run(undefined, {});
      expect(home).toBe(NO_HOME_LOCALITY);
      expect(errors).toContain('preplan_copy.home_locality_missing');
      expect(metrics).toContain('HomeLocalityMissing');
      expect(metrics).not.toContain('HomeLocalityFormMissing');
    });

    it('m7: a form load with no home set is counted apart from HomeLocalityMissing', async () => {
      const { home, errors, metrics } = await run(undefined, {}, 'form');
      expect(home).toBe(NO_HOME_LOCALITY);
      expect(errors).toContain('"purpose":"form"');
      expect(metrics).toContain('HomeLocalityFormMissing');
      expect(metrics).not.toMatch(/"HomeLocalityMissing"/);
    });
  });
});

describe('m2: the home set must be one street-numbering area', () => {
  const client = (send: ReturnType<typeof vi.fn>) =>
    ({ send }) as unknown as DynamoDBDocumentClient;
  it('counts only CT towns, not villages', () => {
    expect(homeTownsThatAreTowns(HOME)).toEqual(['TRUMBULL']);
    const twoTowns = parseHomeLocality({ towns: ['Monroe', 'Stepney', 'Trumbull'] })!;
    expect(homeTownsThatAreTowns(twoTowns)).toEqual(['MONROE', 'TRUMBULL']);
  });

  it('logs a home set naming two towns, once per department', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn().mockResolvedValue({ Item: { towns: ['Monroe', 'Trumbull'] } });
    const dept = toVerifiedDeptId({ deptId: 'TWOTOWN' });
    await loadHomeLocality(client(send), 'alerting', dept, {});
    await loadHomeLocality(client(send), 'alerting', dept, {});
    const lines = errorSpy.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('preplan_copy.home_locality_multi_town'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('MONROE');
    errorSpy.mockRestore();
  });

  it('does not log the tenant-zero set (one town and its villages)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn().mockResolvedValue({
      Item: { towns: ['Trumbull', 'Nichols', 'Long Hill', 'Trumbull Center'], zips: ['06611'] },
    });
    await loadHomeLocality(client(send), 'alerting', toVerifiedDeptId({ deptId: 'ONE' }), {});
    expect(errorSpy.mock.calls.join('\n')).not.toContain('multi_town');
    errorSpy.mockRestore();
  });
});
