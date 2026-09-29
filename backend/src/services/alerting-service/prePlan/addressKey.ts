/**
 * Deterministic street-address normalization for matching a dispatch address to a pre-plan
 * copy. No geocoder: both sides of the match run through this one function, so it only has
 * to make equivalent spellings of the same address collapse to the same key — "123 Main
 * Street, Apt 4" and "123 main st." both become "123 MAIN ST" (unit "4" / none).
 *
 * A wrong pre-plan is worse than none, so the parser is conservative and says when it
 * guessed. An address it cannot read at all (no house number, no street name) gets no key.
 * One it can read but not confidently — no street suffix, words after the street that are
 * neither a unit nor a known place — is returned with `ambiguous: true`, and the matcher
 * (locality.ts) will then only ever show its match flagged "verify address".
 *
 * The street runs from the house number to the LAST street-type word before any unit, town
 * or state ("123 Mount St Joseph Rd", "123 Fox Run Rd"), so a later suffix never becomes a
 * "town". A unit designator is stripped only after the street or after the first comma, so
 * "100 Lot Rd" stays "100 LOT RD". Route numbers stay in the key ("123 RT 111").
 *
 * The key never depends on per-department data (only on the built-in place list), so the
 * copy consumer and the dispatch side always compute the same key. Changing the rules
 * changes stored keys: re-emit every pre-plan afterwards (docs/runbooks/alert-context-replay.md).
 */

import { CT_TOWNS, CT_VILLAGES } from './knownLocalities.js';

export interface NormalizedAddress {
  /** House number + street name + suffix, unit and locality removed — the lookup key. */
  readonly key: string;
  /** The unit/apartment/suite designator(s), or null when the address carries none. */
  readonly unit: string | null;
  /** The unit(s) with their designator for display ("BLDG 2", "APT 4", "REAR"), or null. */
  readonly unitLabel: string | null;
  /** Town/city, or null when the address carries none. Compared, never part of the key. */
  readonly town: string | null;
  /** 5-digit ZIP, or null. */
  readonly zip: string | null;
  /** State (2-letter code or aliased name), or null. */
  readonly state: string | null;
  /**
   * The parse involved a guess (e.g. a town read off a comma-less line): such an address may
   * still match, but never as a verified (unflagged) match.
   */
  readonly ambiguous: boolean;
}

/** A town/village name in the form addresses are compared in ("North Haven" -> "N HAVEN"). */
export function localityKey(name: string): string {
  return tokenize(
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase(),
  ).join(' ');
}

/** Spelled-out forms mapped to the USPS abbreviation both sides are compared in. */
const ALIASES: Readonly<Record<string, string>> = {
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
  CROSSING: 'XING',
  ROUTE: 'RT',
  RTE: 'RT',
  MOUNT: 'MT',
  SAINT: 'ST',
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

/** Street-type suffixes that end the street name (after aliasing). */
const STREET_TYPES = new Set([
  'ST',
  'RD',
  'AVE',
  'BLVD',
  'DR',
  'LN',
  'CT',
  'PL',
  'TER',
  'CIR',
  'PKWY',
  'HWY',
  'TPKE',
  'TRL',
  'SQ',
  'WAY',
  'PATH',
  'LOOP',
  'RUN',
  'ROW',
  'XING',
]);

/** Tokens that may follow the suffix and still belong to the street ("Main St N", "Ave Ext"). */
const STREET_TRAILERS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'EXT']);

// Deliberately not FL (a state), DEPT, or anything else a city/state/ZIP tail can contain.
const UNIT_DESIGNATORS = new Set([
  'APARTMENT',
  'APT',
  'UNIT',
  'SUITE',
  'STE',
  'FLOOR',
  'ROOM',
  'RM',
  'BUILDING',
  'BLDG',
  'LOT',
  'SPACE',
  '#',
]);

/** Part-of-building words that are a unit on their own ("123 Main St Rear"). */
const STANDALONE_UNITS = new Set(['REAR', 'FRONT', 'BSMT', 'BASEMENT', 'LOWER', 'UPPER']);

const ORDINAL = /^\d+(?:ST|ND|RD|TH)$/;

const STATE_CODES = new Set(
  (
    'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH ' +
    'NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'
  ).split(' '),
);

/** Full state names in compared form, mapped to their code. */
const STATE_NAMES: ReadonlyMap<string, string> = new Map(
  (
    [
      ['CONNECTICUT', 'CT'],
      ['NEW YORK', 'NY'],
      ['MASSACHUSETTS', 'MA'],
      ['RHODE ISLAND', 'RI'],
      ['NEW JERSEY', 'NJ'],
      ['PENNSYLVANIA', 'PA'],
      ['VERMONT', 'VT'],
      ['NEW HAMPSHIRE', 'NH'],
      ['MAINE', 'ME'],
    ] as const
  ).map(([name, code]) => [localityKey(name), code]),
);

const ZIP = /^(\d{5})(?:-\d{4})?$/;
const HOUSE_NUMBER = /^\d+[A-Z]?(?:-\d+[A-Z]?)?$/;
const ROUTE_NUMBER = /^\d+[A-Z]?$/;
const UNIT_TOKEN = /^[A-Z0-9]+(?:-[A-Z0-9]+)?$/;
const STATE_ROUTE = /^([A-Z]{2})-(\d+[A-Z]?)$/;

const DIRECTIONALS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

let builtInLocalities: ReadonlySet<string> | undefined;

/** Connecticut towns + local villages, in compared form. */
export function knownLocalities(): ReadonlySet<string> {
  builtInLocalities ??= new Set([...CT_TOWNS, ...CT_VILLAGES].map(localityKey));
  return builtInLocalities;
}

function tokenize(text: string): string[] {
  return (
    text
      // Keep hyphens only between alphanumerics (house ranges like 12-14, units like B-2).
      .replace(/(?<![A-Z0-9])-|-(?![A-Z0-9])/g, ' ')
      .replace(/#/g, ' # ')
      .replace(/[^A-Z0-9#\s-]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 0)
      .map((token) => ALIASES[token] ?? token)
  );
}

function isUnitStart(tokens: readonly string[], i: number): boolean {
  const token = tokens[i] as string;
  return (
    UNIT_DESIGNATORS.has(token) ||
    STANDALONE_UNITS.has(token) ||
    (ORDINAL.test(token) && tokens[i + 1] === 'FLOOR')
  );
}

/**
 * Pulls units out of `tokens`: "<designator> [NO|#] <unit>", "2ND FLOOR", and part-of-building
 * words (REAR, BSMT, ...). A designator only takes the next token if that token is not itself
 * a street type. Returns the units and whatever is left.
 */
function extractUnits(tokens: readonly string[]): {
  units: string[];
  labels: string[];
  rest: string[];
} {
  const units: string[] = [];
  // The same units with their designator, for display ("BLDG 2", "APT 4", "REAR").
  const labels: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (ORDINAL.test(token) && tokens[i + 1] === 'FLOOR') {
      units.push(token);
      labels.push(`${token} FLOOR`);
      i += 1;
      continue;
    }
    if (STANDALONE_UNITS.has(token)) {
      units.push(token);
      labels.push(token);
      continue;
    }
    if (UNIT_DESIGNATORS.has(token)) {
      let next = i + 1;
      if (tokens[next] === 'NO' || (token !== '#' && tokens[next] === '#')) next += 1;
      const unit = tokens[next];
      if (unit !== undefined && UNIT_TOKEN.test(unit) && !STREET_TYPES.has(unit)) {
        units.push(unit);
        labels.push(token === '#' ? `#${unit}` : `${token} ${unit}`);
        i = next;
        continue;
      }
    }
    rest.push(token);
  }
  return { units, labels, rest };
}

/** Longest run of words at the end of `words` (up to three) that is a known place. */
function trailingPlace(words: readonly string[], known: ReadonlySet<string>): number {
  for (let length = Math.min(3, words.length); length >= 1; length -= 1) {
    if (known.has(words.slice(-length).join(' '))) return length;
  }
  return 0;
}

interface Locality {
  readonly town: string | null;
  readonly zip: string | null;
  readonly state: string | null;
  /** Words were left that are not a known place. */
  readonly unknownWords: boolean;
}

/**
 * "TRUMBULL CT 06611" -> town TRUMBULL, zip 06611, state CT. A trailing ZIP and state (code
 * or name) are peeled off; the remaining words are a town only if they are a known place.
 */
function parseLocality(tokens: readonly string[], known: ReadonlySet<string>): Locality {
  const words = [...tokens];
  let zip: string | null = null;
  let state: string | null = null;
  const zipMatch = ZIP.exec(words[words.length - 1] ?? '');
  if (zipMatch) {
    zip = zipMatch[1] as string;
    words.pop();
  }
  const lastTwo = words.slice(-2).join(' ');
  const last = words[words.length - 1] ?? '';
  if (words.length >= 2 && STATE_NAMES.has(lastTwo)) {
    state = STATE_NAMES.get(lastTwo) as string;
    words.splice(-2);
  } else if (STATE_NAMES.has(last)) {
    state = STATE_NAMES.get(last) as string;
    words.pop();
  } else if (STATE_CODES.has(last)) {
    state = last;
    words.pop();
  }
  if (words.length === 0) return { town: null, zip, state, unknownWords: false };
  const joined = words.join(' ');
  return known.has(joined)
    ? { town: joined, zip, state, unknownWords: false }
    : { town: null, zip, state, unknownWords: true };
}

/** "RT 111", "US RT 1", "HWY 8": a numbered route right after the house number, or null. */
function routeAt(tokens: readonly string[]): { route: string[]; length: number } | null {
  const [a, b, c] = [tokens[1], tokens[2], tokens[3]];
  const stateRoute = a ? STATE_ROUTE.exec(a) : null;
  if (stateRoute && STATE_CODES.has(stateRoute[1] as string)) {
    return { route: ['RT', stateRoute[2] as string], length: 1 };
  }
  if ((a === 'RT' || a === 'HWY') && b && ROUTE_NUMBER.test(b)) {
    return { route: ['RT', b], length: 2 };
  }
  if (a === 'US' && (b === 'RT' || b === 'HWY') && c && ROUTE_NUMBER.test(c)) {
    return { route: ['US', 'RT', c], length: 3 };
  }
  if (a && STATE_CODES.has(a) && b === 'RT' && c && ROUTE_NUMBER.test(c)) {
    return { route: ['RT', c], length: 3 };
  }
  return null;
}

/**
 * Where a street with a suffix ends: the last street-type word before any unit — except a
 * final state code standing right after the street or after a known place ("12 OAK CT CT",
 * "12 OAK CT TRUMBULL CT"), which is the state, not a second "Court".
 */
function suffixedStreetEnd(tokens: readonly string[]): number {
  let first = -1;
  for (let i = 2; i < tokens.length; i += 1) {
    if (STREET_TYPES.has(tokens[i] as string)) {
      first = i;
      break;
    }
  }
  if (first < 0) return -1;
  let limit = tokens.length;
  if (ZIP.test(tokens[limit - 1] ?? '')) limit -= 1;
  const last = tokens[limit - 1] ?? '';
  if (limit - 1 > first && STATE_CODES.has(last)) {
    const between = tokens.slice(first + 1, limit - 1);
    const isPlace = (words: readonly string[]) =>
      words.length === 0 || trailingPlace(words, knownLocalities()) === words.length;
    // "N HAVEN" is a place; "N" alone is a trailer ("MAIN ST N CT").
    if (isPlace(between) || isPlace(between.filter((t) => !STREET_TRAILERS.has(t)))) {
      limit -= 1;
    }
  }
  let end = first;
  for (let i = first + 1; i < limit; i += 1) {
    if (isUnitStart(tokens, i)) break;
    if (STREET_TYPES.has(tokens[i] as string)) end = i;
  }
  return end;
}

/**
 * Trailers after the street: EXT always; a directional only when it ends the line or a unit
 * follows ("MAIN ST N", "MAIN ST N APT 4") — never before a word, which is a town ("MAIN ST
 * NORTH HAVEN").
 */
function extendTrailers(tokens: readonly string[], end: number): number {
  let result = end;
  for (let i = end + 1; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token === 'EXT') {
      result = i;
      continue;
    }
    const next = i + 1;
    const nextIsTail =
      next >= tokens.length ||
      isUnitStart(tokens, next) ||
      ZIP.test(tokens[next] as string) ||
      (STATE_CODES.has(tokens[next] as string) && next === tokens.length - 1);
    if (DIRECTIONALS.has(token) && nextIsTail) {
      result = i;
      continue;
    }
    break;
  }
  return result;
}

/**
 * @param extraLocalities place names beyond the built-in list (a department's home villages).
 *   They only decide whether trailing words are a town; they never change the key.
 */
export function normalizeAddress(
  raw: string,
  extraLocalities: ReadonlySet<string> = new Set(),
): NormalizedAddress | null {
  const text = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
  const [streetPart = '', ...tailParts] = text.split(',');
  const tokens = tokenize(streetPart);
  const known =
    extraLocalities.size > 0
      ? new Set([...knownLocalities(), ...extraLocalities])
      : knownLocalities();

  if (!HOUSE_NUMBER.test(tokens[0] ?? '')) return null;
  if (tokens.some((token, i) => token === 'PO' && tokens[i + 1] === 'BOX')) return null;

  let street: string[];
  let remainder: string[];
  let ambiguous = false;

  const route = routeAt(tokens);
  const suffixEnd = route ? -1 : suffixedStreetEnd(tokens);
  if (route) {
    const end = extendTrailers(tokens, route.length);
    street = [tokens[0] as string, ...route.route, ...tokens.slice(route.length + 1, end + 1)];
    remainder = tokens.slice(end + 1);
  } else if (suffixEnd >= 0) {
    const end = extendTrailers(tokens, suffixEnd);
    street = tokens.slice(0, end + 1);
    remainder = tokens.slice(end + 1);
    // "123 Unit 4 Main St": a designator with a number inside the street name.
    ambiguous = street.some(
      (token, i) => i > 0 && UNIT_DESIGNATORS.has(token) && /\d/.test(street[i + 1] ?? ''),
    );
  } else {
    // No suffix ("123 Broadway"): where the street ends is a guess. Peel a trailing ZIP, state
    // and known place, stop at the first unit; the parse is ambiguous either way.
    ambiguous = true;
    let limit = tokens.length;
    if (ZIP.test(tokens[limit - 1] ?? '')) limit -= 1;
    if (limit > 2 && STATE_CODES.has(tokens[limit - 1] as string)) limit -= 1;
    // Built-in places only: the key must never depend on department data (a department's
    // extra names only classify words already outside the key).
    const place = trailingPlace(tokens.slice(2, limit), knownLocalities());
    limit -= place;
    let stop = limit;
    for (let i = 2; i < limit; i += 1) {
      if (isUnitStart(tokens, i)) {
        stop = i;
        break;
      }
    }
    street = tokens.slice(0, stop);
    remainder = tokens.slice(stop);
  }

  if (
    street.length < 2 ||
    !street.slice(1).some((token) => /[A-Z]/.test(token)) ||
    // "123 Apt 4": with no suffix to anchor it, a designator right after the number means
    // there is no street name to key on.
    (!route && suffixEnd < 0 && UNIT_DESIGNATORS.has(street[1] as string))
  ) {
    return null;
  }

  const fromRemainder = extractUnits(remainder);
  const fromTail = extractUnits(tokenize(tailParts.join(' ')));
  const units = [...fromRemainder.units, ...fromTail.units];
  const unitLabels = [...fromRemainder.labels, ...fromTail.labels];

  const lineLocality = parseLocality(fromRemainder.rest, known);
  const tailLocality = parseLocality(fromTail.rest, known);
  const pick = <K extends 'town' | 'zip' | 'state'>(field: K): string | null => {
    const a = lineLocality[field];
    const b = tailLocality[field];
    if (a !== null && b !== null && a !== b) ambiguous = true;
    return b ?? a;
  };
  const town = pick('town');
  const zip = pick('zip');
  const state = pick('state');
  if (lineLocality.unknownWords || tailLocality.unknownWords) ambiguous = true;

  return {
    key: street.join(' '),
    unit: units.length > 0 ? units.join(' ') : null,
    unitLabel: unitLabels.length > 0 ? unitLabels.join(' ') : null,
    town,
    zip,
    state,
    ambiguous,
  };
}
