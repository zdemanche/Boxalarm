/**
 * Deterministic street-address normalization for matching a dispatch address to a pre-plan
 * copy. No geocoder: both sides of the match run through this one function, so it only has
 * to make equivalent spellings of the same address collapse to the same key — "123 Main
 * Street, Apt 4" and "123 main st." both become "123 MAIN ST" (unit "4" / none).
 *
 * A wrong pre-plan is worse than none, so the parser is conservative: an address it cannot
 * read confidently (no house number, no street name) gets no key and never matches, and a
 * unit designator is only stripped where it cannot be part of the street name — after the
 * street suffix, or after the first comma — so "100 Lot Rd" stays "100 LOT RD".
 *
 * Changing the rules changes stored keys: re-emit every pre-plan afterwards
 * (docs/runbooks/alert-context-replay.md).
 */

export interface NormalizedAddress {
  /** House number + street name + suffix, unit and locality removed — the lookup key. */
  readonly key: string;
  /** The unit/apartment/suite designator(s), or null when the address carries none. */
  readonly unit: string | null;
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

const STATE_CODES = new Set(
  (
    'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH ' +
    'NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'
  ).split(' '),
);
const STATE_NAMES = new Set([
  'ALABAMA',
  'ALASKA',
  'ARIZONA',
  'ARKANSAS',
  'CALIFORNIA',
  'COLORADO',
  'CONNECTICUT',
  'DELAWARE',
  'FLORIDA',
  'GEORGIA',
  'HAWAII',
  'IDAHO',
  'ILLINOIS',
  'INDIANA',
  'IOWA',
  'KANSAS',
  'KENTUCKY',
  'LOUISIANA',
  'MAINE',
  'MARYLAND',
  'MASSACHUSETTS',
  'MICHIGAN',
  'MINNESOTA',
  'MISSISSIPPI',
  'MISSOURI',
  'MONTANA',
  'NEBRASKA',
  'NEVADA',
  'NEW HAMPSHIRE',
  'NEW JERSEY',
  'NEW MEXICO',
  'NEW YORK',
  'NORTH CAROLINA',
  'NORTH DAKOTA',
  'OHIO',
  'OKLAHOMA',
  'OREGON',
  'PENNSYLVANIA',
  'RHODE ISLAND',
  'SOUTH CAROLINA',
  'SOUTH DAKOTA',
  'TENNESSEE',
  'TEXAS',
  'UTAH',
  'VERMONT',
  'VIRGINIA',
  'WASHINGTON',
  'WEST VIRGINIA',
  'WISCONSIN',
  'WYOMING',
]);
const ZIP = /^(\d{5})(?:-\d{4})?$/;

const HOUSE_NUMBER = /^\d+[A-Z]?(?:-\d+[A-Z]?)?$/;
const UNIT_TOKEN = /^[A-Z0-9]+(?:-[A-Z0-9]+)?$/;

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

/**
 * Pulls "<designator> [NO|#] <unit>" pairs out of `tokens`, returning the units and whatever is
 * left. A designator only takes the next token if that token is not itself a street type.
 */
function extractUnits(tokens: readonly string[]): { units: string[]; rest: string[] } {
  const units: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (UNIT_DESIGNATORS.has(token)) {
      let next = i + 1;
      if (tokens[next] === 'NO' || (token !== '#' && tokens[next] === '#')) next += 1;
      const unit = tokens[next];
      if (unit !== undefined && UNIT_TOKEN.test(unit) && !STREET_TYPES.has(unit)) {
        units.push(unit);
        i = next;
        continue;
      }
    }
    rest.push(token);
  }
  return { units, rest };
}

/**
 * "TRUMBULL CT 06611" -> town TRUMBULL, zip 06611. A trailing ZIP and state (code or name) are
 * peeled off; whatever words remain are the town. Runs only on text after the street, so a
 * state code that is also a suffix ("CT" = Court) is never taken from the street itself.
 */
function parseLocality(tokens: readonly string[]): {
  town: string | null;
  zip: string | null;
  state: string | null;
} {
  const words = [...tokens];
  let zip: string | null = null;
  let state: string | null = null;
  const zipMatch = ZIP.exec(words[words.length - 1] ?? '');
  if (zipMatch) {
    zip = zipMatch[1] as string;
    words.pop();
  }
  // Names were aliased by tokenize ("NORTH CAROLINA" -> "N CAROLINA"); compare both forms.
  const lastTwo = words.slice(-2).join(' ');
  if (words.length >= 2 && (STATE_NAMES.has(lastTwo) || STATE_NAMES.has(unalias(lastTwo)))) {
    state = unalias(lastTwo);
    words.splice(-2);
  } else if (
    words.length >= 1 &&
    (STATE_CODES.has(words[words.length - 1] as string) ||
      STATE_NAMES.has(words[words.length - 1] as string))
  ) {
    state = words.pop() as string;
  }
  return { town: words.length > 0 ? words.join(' ') : null, zip, state: stateCode(state) };
}

const UNALIAS: Readonly<Record<string, string>> = { N: 'NORTH', S: 'SOUTH', W: 'WEST' };

/** "CONNECTICUT" -> "CT" so a code and a name compare equal (only the names we list). */
const STATE_NAME_CODES: Readonly<Record<string, string>> = {
  CONNECTICUT: 'CT',
  'NEW YORK': 'NY',
  MASSACHUSETTS: 'MA',
  'RHODE ISLAND': 'RI',
  'NEW JERSEY': 'NJ',
};

function stateCode(state: string | null): string | null {
  return state === null ? null : (STATE_NAME_CODES[state] ?? state);
}

function unalias(words: string): string {
  return words
    .split(' ')
    .map((word) => UNALIAS[word] ?? word)
    .join(' ');
}

/** Index of the last token of the street name, or -1 when no street-type suffix is present. */
function streetEnd(tokens: readonly string[]): number {
  // Start at 2: the house number and at least one name token come first, so a designator word
  // used as a street name ("40 Building Rd") is read as the name, not as a unit.
  for (let i = 2; i < tokens.length; i += 1) {
    if (STREET_TYPES.has(tokens[i] as string)) {
      let end = i;
      while (end + 1 < tokens.length && STREET_TRAILERS.has(tokens[end + 1] as string)) {
        end += 1;
      }
      return end;
    }
  }
  return -1;
}

export function normalizeAddress(raw: string): NormalizedAddress | null {
  const text = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const [streetPart = '', ...tailParts] = text.split(',');
  const tokens = tokenize(streetPart);

  if (!HOUSE_NUMBER.test(tokens[0] ?? '')) {
    return null;
  }

  let street: string[];
  let remainder: string[];
  const end = streetEnd(tokens);
  if (end >= 0) {
    street = tokens.slice(0, end + 1);
    remainder = tokens.slice(end + 1);
  } else {
    // No recognisable suffix ("900 Route 25"): only an explicit "#" can start a unit.
    const hash = tokens.indexOf('#', 1);
    street = hash >= 0 ? tokens.slice(0, hash) : tokens;
    remainder = hash >= 0 ? tokens.slice(hash) : [];
  }

  if (
    street.length < 2 ||
    !street.slice(1).some((token) => /[A-Z]/.test(token)) ||
    // "123 Apt 4": with no suffix to anchor it, a designator right after the number means
    // there is no street name to key on.
    (end < 0 && UNIT_DESIGNATORS.has(street[1] as string))
  ) {
    return null;
  }

  const fromRemainder = extractUnits(remainder);
  const fromTail = extractUnits(tokenize(tailParts.join(' ')));
  const units = [...fromRemainder.units, ...fromTail.units];

  // Locality is whatever follows the street: on a comma-less line ("123 MAIN ST TRUMBULL CT
  // 06611") and/or after the first comma ("123 Main St, Trumbull, CT"). Extra words make the
  // town longer, never shorter, so they can only cause a (safe) mismatch. Without a suffix the
  // street's end is unknown, so those words stay in the key instead.
  const localityTokens = [...(end >= 0 ? fromRemainder.rest : []), ...fromTail.rest];
  const { town, zip, state } = parseLocality(localityTokens);
  const key = end >= 0 ? street : [...street, ...fromRemainder.rest];

  return {
    key: key.join(' '),
    unit: units.length > 0 ? units.join(' ') : null,
    town,
    zip,
    state,
    // A town read off a comma-less line is a guess about where the street ended.
    ambiguous: end >= 0 && fromRemainder.rest.length > 0 && town !== null,
  };
}
