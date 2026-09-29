/**
 * Deterministic street-address normalization for matching a dispatch address to a pre-plan
 * copy. No geocoder: both sides of the match run through this one function, so it only has
 * to make equivalent spellings of the same address collapse to the same key — "123 Main
 * Street, Apt 4" and "123 main st." both become "123 MAIN ST" (unit "4" / none).
 *
 * Changing the rules changes stored keys: PRE_PLAN_COPY items written under the old rules
 * keep their old key until the next inspections.preplan.updated for that occupancy.
 */

export interface NormalizedAddress {
  /** Street line with the unit removed — the lookup key. */
  readonly key: string;
  /** The unit/apartment/suite designator, or null when the address carries none. */
  readonly unit: string | null;
}

const SUFFIXES: Readonly<Record<string, string>> = {
  STREET: 'ST',
  STR: 'ST',
  ROAD: 'RD',
  AVENUE: 'AVE',
  AV: 'AVE',
  AVN: 'AVE',
  BOULEVARD: 'BLVD',
  DRIVE: 'DR',
  LANE: 'LN',
  COURT: 'CT',
  PLACE: 'PL',
  TERRACE: 'TER',
  TERR: 'TER',
  CIRCLE: 'CIR',
  PARKWAY: 'PKWY',
  HIGHWAY: 'HWY',
  TURNPIKE: 'TPKE',
  TRAIL: 'TRL',
  SQUARE: 'SQ',
  EXTENSION: 'EXT',
  ROUTE: 'RT',
  RTE: 'RT',
  MOUNT: 'MT',
  NORTH: 'N',
  SOUTH: 'S',
  EAST: 'E',
  WEST: 'W',
  NORTHEAST: 'NE',
  NORTHWEST: 'NW',
  SOUTHEAST: 'SE',
  SOUTHWEST: 'SW',
  FIRST: '1ST',
  SECOND: '2ND',
  THIRD: '3RD',
  FOURTH: '4TH',
  FIFTH: '5TH',
  SIXTH: '6TH',
  SEVENTH: '7TH',
  EIGHTH: '8TH',
  NINTH: '9TH',
  TENTH: '10TH',
};

// Deliberately not FL (a state), DEPT, or anything else a city/state/ZIP tail can contain.
const UNIT_DESIGNATORS = 'APARTMENT|APT|UNIT|SUITE|STE|FLOOR|ROOM|RM|BUILDING|BLDG|LOT|SPACE|#';

// A designator, optional "." / "#" / "NO", then the unit token. The designator must start a
// word (or be "#") so "APT" inside a street name never matches.
const UNIT_PATTERN = new RegExp(
  `(?:^|[\\s,])(?:${UNIT_DESIGNATORS})(?![A-Z])\\.?\\s*(?:#|NO\\.?)?\\s*([A-Z0-9]+(?:-[A-Z0-9]+)?)`,
  'g',
);

export function normalizeAddress(raw: string): NormalizedAddress | null {
  let text = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  // Every designator is removed ("Bldg 2 Apt 4" -> unit "2 4"), so none leaks into the key.
  const units: string[] = [];
  text = text.replace(UNIT_PATTERN, (_match, token: string) => {
    units.push(token);
    return ' ';
  });
  const unit = units.length > 0 ? units.join(' ') : null;

  // Street line only: everything after the first comma is city/state/ZIP (or a unit, already
  // removed), which one side of the match routinely omits.
  const streetLine = text.split(',')[0] ?? '';

  const tokens = streetLine
    // Keep hyphens only between alphanumerics (house ranges like 12-14); every other
    // punctuation mark is a separator.
    .replace(/(?<![A-Z0-9])-|-(?![A-Z0-9])/g, ' ')
    .replace(/[^A-Z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => SUFFIXES[token] ?? token);

  if (tokens.length === 0) {
    return null;
  }
  return { key: tokens.join(' '), unit };
}
