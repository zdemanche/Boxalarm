import { describe, expect, it } from 'vitest';
import { buildMapLink } from './mapLink.js';

describe('buildMapLink', () => {
  it('encodes a plain address into a Google Maps search deep link', () => {
    expect(buildMapLink('123 Main St')).toBe(
      'https://www.google.com/maps/search/?api=1&query=123%20Main%20St',
    );
  });

  it('encodes special characters (AC1 — map link must be a valid URL for any dispatch address)', () => {
    expect(buildMapLink('Main & Elm, Apt #4')).toBe(
      'https://www.google.com/maps/search/?api=1&query=Main%20%26%20Elm%2C%20Apt%20%234',
    );
  });
});
