import { describe, expect, it } from 'vitest';
import { normalizeAddress } from './addressKey.js';

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
    });
    expect(normalizeAddress('5 Elm St, Trumbull, CT 06611')).toEqual({
      key: '5 ELM ST',
      unit: null,
    });
  });

  it('does not treat a designator embedded in a street name as a unit', () => {
    expect(normalizeAddress('10 Aptos Way')).toEqual({ key: '10 APTOS WAY', unit: null });
    expect(normalizeAddress('10 Unity Rd')).toEqual({ key: '10 UNITY RD', unit: null });
  });

  it('keeps a hyphenated house-number range but splits other hyphens', () => {
    expect(normalizeAddress('12-14 Main St')?.key).toBe('12-14 MAIN ST');
    expect(normalizeAddress('12 Main St - rear')?.key).toBe('12 MAIN ST REAR');
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
      expect(normalizeAddress(raw)).toEqual({ key, unit: null });
    });

    it('still strips a real unit that follows the street suffix', () => {
      expect(normalizeAddress('100 Lot Rd Lot 7')).toEqual({ key: '100 LOT RD', unit: '7' });
      expect(normalizeAddress('40 Building Rd, Building 2')).toEqual({
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
});
