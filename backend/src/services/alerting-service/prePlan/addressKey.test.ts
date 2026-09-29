import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { knownLocalities, normalizeAddress } from './addressKey.js';

describe('normalizeAddress', () => {
  it.each([
    ['123 Main Street', '123 MAIN ST'],
    ['123 main st.', '123 MAIN ST'],
    ['  123   Main    St  ', '123 MAIN ST'],
    ['123 MAIN ST', '123 MAIN ST'],
    ['45 Old Mill Road', '45 OLD MILL RD'],
    ['45 Old Mill Rd.', '45 OLD MILL RD'],
    ['9 Park Avenue', '9 PARK AVE'],
    ['9 Park Av', '9 PARK AVE'],
    ['200 White Plains Rd', '200 WHITE PLAINS RD'],
    ['17 North Maple Lane', '17 N MAPLE LN'],
    ['17 N. Maple Ln', '17 N MAPLE LN'],
    ['5 Daniels Farm Boulevard', '5 DANIELS FARM BLVD'],
    ['900 Route 25', '900 RT 25'],
    ['900 Rte. 25', '900 RT 25'],
    ['12 First Street', '12 1ST ST'],
    ['12 1st St', '12 1ST ST'],
    ['12 Café Plaza Drive', '12 CAFE PLAZA DR'],
  ])('%s -> %s', (raw, key) => {
    expect(normalizeAddress(raw)?.key).toBe(key);
  });

  it('collapses every equivalent spelling of one address to the same key', () => {
    const spellings = [
      '123 Main Street',
      '123 main st.',
      '123 MAIN ST, Trumbull, CT 06611',
      '123 Main St Apt 4',
      '123 Main St., Unit #4',
      '123 Main St #4',
    ];
    const keys = new Set(spellings.map((raw) => normalizeAddress(raw)?.key));
    expect([...keys]).toEqual(['123 MAIN ST']);
  });

  it.each([
    ['123 Main St Apt 4', '4'],
    ['123 Main St, Apt. 4B', '4B'],
    ['123 Main St Apartment 12', '12'],
    ['123 Main St Unit 7', '7'],
    ['123 Main St Suite 200', '200'],
    ['123 Main St Ste 200', '200'],
    ['123 Main St #3', '3'],
    ['123 Main St Unit No. 9', '9'],
    ['123 Main St Bldg 2 Apt 4', '2 4'],
    ['123 Main St Floor 3', '3'],
  ])('strips the unit from %s (unit %s)', (raw, unit) => {
    const normalized = normalizeAddress(raw);
    expect(normalized?.key).toBe('123 MAIN ST');
    expect(normalized?.unit).toBe(unit);
  });

  it('reports no unit when the address has none', () => {
    expect(normalizeAddress('123 Main St')?.unit).toBeNull();
  });

  it('does not mistake a state abbreviation or ZIP in the city tail for a unit', () => {
    expect(normalizeAddress('1 Ocean Dr, Miami, FL 33139')).toEqual({
      key: '1 OCEAN DR',
      unit: null,
      unitLabel: null,
      // Not a known place: never guessed to be a town, and the parse is flagged ambiguous.
      town: null,
      zip: '33139',
      state: 'FL',
      ambiguous: true,
    });
    expect(normalizeAddress('5 Elm St, Trumbull, CT 06611')).toEqual({
      key: '5 ELM ST',
      unit: null,
      unitLabel: null,
      town: 'TRUMBULL',
      zip: '06611',
      state: 'CT',
      ambiguous: false,
    });
  });

  describe('locality (MAJOR-2: kept, compared, never part of the key)', () => {
    it.each([
      ['123 Main St, Trumbull, CT 06611', 'TRUMBULL', '06611'],
      ['123 MAIN ST TRUMBULL CT 06611', 'TRUMBULL', '06611'],
      ['123 Main St Trumbull CT', 'TRUMBULL', null],
      ['123 Main St, Bridgeport, Connecticut', 'BRIDGEPORT', null],
      ['123 Main St, Apt 4, Trumbull, CT 06611-1234', 'TRUMBULL', '06611'],
      ['123 Main St Apt 4 Trumbull CT 06611', 'TRUMBULL', '06611'],
      ['123 Main St, New Canaan, New York 10001', 'NEW CANAAN', '10001'],
      ['123 Main St', null, null],
      ['123 Main St, CT 06611', null, '06611'],
    ])('%s -> town %s, zip %s', (raw, town, zip) => {
      expect(normalizeAddress(raw)).toMatchObject({ key: '123 MAIN ST', town, zip });
    });

    it('a comma-less CAD address keys the same as the comma form', () => {
      expect(normalizeAddress('123 MAIN ST TRUMBULL CT 06611')?.key).toBe(
        normalizeAddress('123 Main Street, Trumbull, CT')?.key,
      );
    });

    it('never peels a state code off the street itself ("12 Oak Ct" keeps its Court)', () => {
      expect(normalizeAddress('12 Oak Ct')).toMatchObject({ key: '12 OAK CT', town: null });
      expect(normalizeAddress('12 Oak Ct CT 06611')).toMatchObject({
        key: '12 OAK CT',
        town: null,
        zip: '06611',
      });
    });

    it('two towns on one street keep one key but different towns', () => {
      const trumbull = normalizeAddress('123 Main St, Trumbull, CT');
      const bridgeport = normalizeAddress('123 Main St, Bridgeport, CT');
      expect(trumbull?.key).toBe(bridgeport?.key);
      expect(trumbull?.town).not.toBe(bridgeport?.town);
    });
  });

  it('does not treat a designator embedded in a street name as a unit', () => {
    expect(normalizeAddress('10 Aptos Way')).toMatchObject({ key: '10 APTOS WAY', unit: null });
    expect(normalizeAddress('10 Unity Rd')).toMatchObject({ key: '10 UNITY RD', unit: null });
  });

  it('keeps a hyphenated house-number range but splits other hyphens', () => {
    expect(normalizeAddress('12-14 Main St')?.key).toBe('12-14 MAIN ST');
    // "rear" is a part-of-building unit.
    expect(normalizeAddress('12 Main St - rear')).toMatchObject({
      key: '12 MAIN ST',
      unit: 'REAR',
    });
  });

  it('never emits the pk delimiter, so the key is safe inside a department-scoped key', () => {
    const normalized = normalizeAddress('12 Main St #4');
    expect(normalized?.key).toBe('12 MAIN ST');
    expect(normalized?.key).not.toContain('#');
  });

  it('is deterministic and idempotent', () => {
    const once = normalizeAddress('123 Main Street, Apt 4');
    expect(normalizeAddress('123 Main Street, Apt 4')).toEqual(once);
    expect(normalizeAddress(once?.key ?? '')?.key).toBe(once?.key);
  });

  it.each(['', '   ', ',,,', '---'])(
    'returns null for an address with no street text (%j)',
    (raw) => {
      expect(normalizeAddress(raw)).toBeNull();
    },
  );

  describe('designator words used as street names (MAJOR-1: never collapse to the house number)', () => {
    it.each([
      ['100 Lot Rd', '100 LOT RD'],
      ['40 Building Rd', '40 BUILDING RD'],
      ['9 Floor Ct', '9 FLOOR CT'],
      ['12 Rm Rd', '12 RM RD'],
      ['5 Space Ln', '5 SPACE LN'],
      ['123 Ste Marie Ave', '123 STE MARIE AVE'],
      ['7 Suite Way', '7 SUITE WAY'],
      ['100 Unit St', '100 UNIT ST'],
      ['8 Apartment Row', '8 APARTMENT ROW'],
    ])('%s keeps its street (%s)', (raw, key) => {
      expect(normalizeAddress(raw)).toMatchObject({ key, unit: null });
    });

    it('still strips a real unit that follows the street suffix', () => {
      expect(normalizeAddress('100 Lot Rd Lot 7')).toMatchObject({ key: '100 LOT RD', unit: '7' });
      expect(normalizeAddress('40 Building Rd, Building 2')).toMatchObject({
        key: '40 BUILDING RD',
        unit: '2',
      });
    });

    it('two different designator-named streets at one number never share a key', () => {
      const keys = ['100 Lot Rd', '100 Space Ln', '100 Floor Ct'].map(
        (raw) => normalizeAddress(raw)?.key,
      );
      expect(new Set(keys).size).toBe(3);
    });

    it('a designator never consumes a street-type token', () => {
      expect(normalizeAddress('12 Main St, Apt Rd')?.unit).toBeNull();
    });
  });

  describe('addresses it cannot read confidently get no key (minor 6)', () => {
    it.each([
      ['Main St', 'no house number'],
      ['Main St & Elm St', 'an intersection'],
      ['#12 Main St', 'a unit where the house number should be'],
      ['123', 'a house number alone'],
      ['123 4', 'no alphabetic street token'],
      ['123 Apt 4', 'unit-only after the number'],
    ])('%s (%s) -> null', (raw) => {
      expect(normalizeAddress(raw)).toBeNull();
    });
  });

  it('keeps 12 and 12A (and 1 and 11) apart', () => {
    expect(normalizeAddress('12 Main St')?.key).not.toBe(normalizeAddress('12A Main St')?.key);
    expect(normalizeAddress('1 Main St')?.key).not.toBe(normalizeAddress('11 Main St')?.key);
  });

  describe('round-2 B: the street runs to its last suffix; only known places become towns', () => {
    it.each([
      ['123 Mount St Joseph Rd', '123 MT ST JOSEPH RD'],
      ['123 Fox Run Rd', '123 FOX RUN RD'],
      ['123 Mill Run Rd', '123 MILL RUN RD'],
      ['123 Village Sq Dr', '123 VILLAGE SQ DR'],
      ['2 Lakeview Ter Way', '2 LAKEVIEW TER WAY'],
      ['123 Saint Johns Pl', '123 ST JOHNS PL'],
      ['123 Old Town Rd Ext N', '123 OLD TOWN RD EXT N'],
    ])('%s -> %s, no "town" made of a suffix', (raw, key) => {
      expect(normalizeAddress(raw)).toMatchObject({ key, town: null, ambiguous: false });
    });

    it('a comma-less known town is read as the town (and the state is not a second Court)', () => {
      expect(normalizeAddress('12 Main St North Haven CT')).toMatchObject({
        key: '12 MAIN ST',
        town: 'N HAVEN',
        state: 'CT',
        ambiguous: false,
      });
      expect(normalizeAddress('12 Main St West Haven')).toMatchObject({
        key: '12 MAIN ST',
        town: 'W HAVEN',
      });
      expect(normalizeAddress('12 Oak Ct Trumbull Ct')).toMatchObject({
        key: '12 OAK CT',
        town: 'TRUMBULL',
        state: 'CT',
      });
      expect(normalizeAddress('12 MAIN ST TRUMBULL CT 06611')).toMatchObject({
        key: '12 MAIN ST',
        town: 'TRUMBULL',
        ambiguous: false,
      });
    });

    it('a directional is folded into the street only when nothing but a unit follows', () => {
      expect(normalizeAddress('12 Main St W')).toMatchObject({ key: '12 MAIN ST W', town: null });
      expect(normalizeAddress('123 Main St N Apt 4')).toMatchObject({
        key: '123 MAIN ST N',
        unit: '4',
      });
    });

    it('trailing words that are not a known place are never a town: the parse is ambiguous', () => {
      for (const raw of ['123 Kings Hwy Cutoff', '12 Main St Fl 2', '123 Main St Rear Bldg']) {
        expect(normalizeAddress(raw), raw).toMatchObject({ town: null, ambiguous: true });
      }
      expect(normalizeAddress('123 Kings Hwy Cutoff')?.key).toBe('123 KINGS HWY');
    });

    it('a department home village is a place only when passed in, and never changes the key', () => {
      expect(normalizeAddress('123 Main St Plattsville')).toMatchObject({ ambiguous: true });
      expect(normalizeAddress('123 Main St Plattsville', new Set(['PLATTSVILLE']))).toMatchObject({
        key: '123 MAIN ST',
        town: 'PLATTSVILLE',
        ambiguous: false,
      });
    });

    it.each([
      ['123 Route 111', '123 RT 111'],
      ['123 Rte 111', '123 RT 111'],
      ['123 Rt. 111', '123 RT 111'],
      ['123 CT-111', '123 RT 111'],
      ['123 CT Route 111', '123 RT 111'],
      ['123 US Hwy 1', '123 US RT 1'],
      ['123 US Highway 1', '123 US RT 1'],
    ])('keeps the route number in the key: %s -> %s', (raw, key) => {
      expect(normalizeAddress(raw)).toMatchObject({ key, town: null, ambiguous: false });
    });

    it('a route with a comma-less town keeps town and state out of the key', () => {
      expect(normalizeAddress('123 Route 111 Monroe CT')).toMatchObject({
        key: '123 RT 111',
        town: 'MONROE',
        state: 'CT',
      });
    });

    it('a street with no suffix is always ambiguous (its end is a guess)', () => {
      expect(normalizeAddress('123 Broadway')).toMatchObject({
        key: '123 BROADWAY',
        ambiguous: true,
      });
      expect(normalizeAddress('123 Broadway Apt 4')).toMatchObject({
        key: '123 BROADWAY',
        unit: '4',
      });
    });

    it('part-of-building words are units, and "2nd Floor" is a floor unit', () => {
      expect(normalizeAddress('123 Main St Rear')).toMatchObject({
        unit: 'REAR',
        ambiguous: false,
      });
      expect(normalizeAddress('12 Main St 2nd Floor Rear')).toMatchObject({ unit: '2ND REAR' });
    });

    it('PO boxes are not addresses', () => {
      expect(normalizeAddress('PO Box 123')).toBeNull();
      expect(normalizeAddress('123 PO Box')).toBeNull();
    });
  });

  describe("the round-2 reviewer's adversarial corpus", () => {
    const corpus = readFileSync(new URL('./__fixtures__/addressCases.txt', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);

    it('is loaded', () => {
      expect(corpus.length).toBeGreaterThan(130);
    });

    it.each(corpus)(
      '%j parses deterministically, never keys a "#", never guesses an unknown town',
      (raw) => {
        const once = normalizeAddress(raw);
        expect(normalizeAddress(raw)).toEqual(once);
        if (once) {
          expect(once.key).not.toContain('#');
          expect(once.key.split(' ')[0]).toMatch(/^\d/);
          if (once.town !== null) {
            expect(knownLocalities().has(once.town), once.town).toBe(true);
          }
        }
      },
    );
  });
});
