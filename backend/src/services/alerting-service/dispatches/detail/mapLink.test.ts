import { describe, expect, it } from 'vitest';
import { buildMapLink } from './mapLink.js';

describe('buildMapLink', () => {
  it('encodes a plain address into a Google Maps search deep link', () => {
    expect(buildMapLink({ address: '123 Main St' })).toBe(
      'https://www.google.com/maps/search/?api=1&query=123%20Main%20St',
    );
  });

  it('encodes special characters (AC1 — map link must be a valid URL for any dispatch address)', () => {
    expect(buildMapLink({ address: 'Main & Elm, Apt #4' })).toBe(
      'https://www.google.com/maps/search/?api=1&query=Main%20%26%20Elm%2C%20Apt%20%234',
    );
  });

  it('prefers latitude/longitude over the address when both coordinates are present', () => {
    expect(buildMapLink({ address: '123 Main St', latitude: 41.2429, longitude: -73.2007 })).toBe(
      'https://www.google.com/maps/search/?api=1&query=41.2429%2C-73.2007',
    );
  });

  it('falls back to the address when only one coordinate is present', () => {
    expect(buildMapLink({ address: '123 Main St', latitude: 41.2429 })).toBe(
      'https://www.google.com/maps/search/?api=1&query=123%20Main%20St',
    );
  });
});
