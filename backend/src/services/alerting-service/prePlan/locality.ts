import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { logError } from '../dispatches/logger.js';
import { localityKey, type NormalizedAddress } from './addressKey.js';
import { CT_TOWNS } from './knownLocalities.js';

/**
 * A department's home locality: every town, village and ZIP its own addresses are written
 * with (Nichols FD: Trumbull, Nichols, Long Hill, Trumbull Center; 06611). Occupancy
 * addresses carry no town, so a town-less pre-plan inherits this set — that is what lets a
 * mutual-aid dispatch to "123 Main St, Bridgeport" be told apart from Trumbull's 123 Main St.
 *
 * Source, in order (docs/runbooks/alert-context-replay.md, "Home locality"):
 *  1. the alerting-table item DEPT#{deptId}#CONFIG / HOME_LOCALITY (partition / sort key)
 *     ({ towns: string[], zips: string[], state?: string }) — editable per department;
 *  2. the ALERTING_HOME_LOCALITY env var (same JSON plus the `deptId` it is for; ignored for
 *     any other department), set by infrastructure from the stack config
 *     `boxalarm-infra:alertingHomeLocality` (default seeded per stack deptId);
 *  3. none — then nothing is verified against the home area (town-less copies and home-town
 *     dispatches are flagged); only an explicit same town/ZIP on both sides still verifies.
 */
/*
 * The home set must be ONE street-numbering area: a single town and its villages/sections
 * (round-4 m2). Any two home names are treated as the same place, which is right for
 * "Nichols" vs "Trumbull" (one Main St) and wrong for two towns ("12 Main St, Monroe" and
 * "12 Main St, Trumbull" are different buildings). A set naming more than one CT town is
 * logged (preplan_copy.home_locality_multi_town) and should be split per department.
 */
export interface HomeLocality {
  /** Town/village names as configured, for display (the manual-entry locality choice). */
  readonly names: readonly string[];
  /** The same names in compared form (localityKey). */
  readonly towns: ReadonlySet<string>;
  readonly zips: ReadonlySet<string>;
  readonly state: string | null;
}

export const NO_HOME_LOCALITY: HomeLocality = {
  names: [],
  towns: new Set(),
  zips: new Set(),
  state: null,
};

export const HOME_LOCALITY_SK = 'HOME_LOCALITY';

const METRIC_NAMESPACE = 'Boxalarm/alerting-pre-plan';

export function homeLocalityKey(deptId: VerifiedDeptId) {
  return { pk: buildDeptScopedPk(deptId, 'CONFIG'), sk: HOME_LOCALITY_SK };
}

export function parseHomeLocality(raw: unknown): HomeLocality | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const strings = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  const names = strings(value.towns)
    .map((name) => name.trim())
    .filter((name) => localityKey(name).length > 0);
  const towns = names.map(localityKey);
  const zips = strings(value.zips).filter((zip) => /^\d{5}$/.test(zip));
  if (towns.length === 0 && zips.length === 0) return undefined;
  return {
    names,
    towns: new Set(towns),
    zips: new Set(zips),
    state: typeof value.state === 'string' ? value.state.trim().toUpperCase() || null : null,
  };
}

/**
 * The stack default, which carries the deptId it was configured for and applies to that
 * department only — a second department served by the same Lambda without its own item must
 * not inherit the first one's towns (round-3 minor 2).
 */
function fromEnv(env: NodeJS.ProcessEnv, deptId: VerifiedDeptId): HomeLocality | undefined {
  const raw = env.ALERTING_HOME_LOCALITY;
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    reportInvalid('env', deptId, error);
    return undefined;
  }
  const forDept = (parsed as { deptId?: unknown } | null)?.deptId;
  if (forDept !== deptId) return undefined;
  const home = parseHomeLocality(parsed);
  if (!home) reportInvalid('env', deptId, new Error('no usable towns or zips'));
  return home;
}

let ctTownKeys: ReadonlySet<string> | undefined;
const warnedMultiTown = new Set<string>();

/** Home names that are CT towns (not villages): more than one breaks the one-area rule. */
export function homeTownsThatAreTowns(home: HomeLocality): string[] {
  ctTownKeys ??= new Set(CT_TOWNS.map(localityKey));
  return [...home.towns].filter((town) => ctTownKeys?.has(town));
}

/** Logged once per department per container: the matcher still runs, as configured. */
function warnIfMultiTown(home: HomeLocality, deptId: VerifiedDeptId): HomeLocality {
  const towns = homeTownsThatAreTowns(home);
  if (towns.length > 1 && !warnedMultiTown.has(deptId)) {
    warnedMultiTown.add(deptId);
    logError(
      'preplan_copy.home_locality_multi_town',
      new Error('the home locality names more than one town; it must be one numbering area'),
      { deptId, towns },
    );
  }
  return home;
}

/** A present-but-unusable home locality is never silent (round-3 minor 3). */
function reportInvalid(source: 'item' | 'env', deptId: VerifiedDeptId, error: unknown): void {
  logError('preplan_copy.home_locality_invalid', error, { deptId, source });
  emitOutcomeMetric(METRIC_NAMESPACE, 'HomeLocalityInvalid', source);
}

/**
 * Why the home set is being loaded. Only a dispatch detail served without one counts as
 * `HomeLocalityMissing` (alarmed: every pre-plan on that alert is flagged); a manual-entry
 * form load counts separately as `HomeLocalityFormMissing` (round-4 m7).
 */
export type HomeLocalityPurpose = 'dispatch' | 'form';

/** Never throws: a failed read degrades to "unverifiable" (every match flagged), not to none. */
export async function loadHomeLocality(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  env: NodeJS.ProcessEnv,
  purpose: HomeLocalityPurpose = 'dispatch',
): Promise<HomeLocality> {
  try {
    const { Item } = await client.send(
      new GetCommand({ TableName: tableName, Key: homeLocalityKey(deptId) }),
    );
    const configured = parseHomeLocality(Item);
    if (configured) return warnIfMultiTown(configured, deptId);
    if (Item) reportInvalid('item', deptId, new Error('no usable towns or zips'));
  } catch (error) {
    logError('preplan_copy.home_locality_read_failed', error, { deptId });
  }
  const fallback = fromEnv(env, deptId);
  if (fallback) return warnIfMultiTown(fallback, deptId);
  // Served with no home set: every address match is flagged (alarmed in infrastructure,
  // pre-plan-copies.ts); the form offers only "Other town".
  logError('preplan_copy.home_locality_missing', new Error('no home locality configured'), {
    deptId,
    purpose,
  });
  emitOutcomeMetric(
    METRIC_NAMESPACE,
    purpose === 'dispatch' ? 'HomeLocalityMissing' : 'HomeLocalityFormMissing',
  );
  return NO_HOME_LOCALITY;
}

export type LocalityVerdict = 'VERIFIED' | 'UNVERIFIED' | 'REJECT';

type Comparison = 'agree' | 'conflict' | 'unknown' | 'none';

/** A dispatch part against one known value (the copy's own). */
function compareValue(dispatchValue: string | null, copyValue: string | null): Comparison {
  if (dispatchValue === null) return 'none';
  if (copyValue === null) return 'unknown';
  return dispatchValue === copyValue ? 'agree' : 'conflict';
}

/** A dispatch part against the whole home set (Nichols and Trumbull both agree). */
function compareHome(dispatchValue: string | null, homeSet: ReadonlySet<string>): Comparison {
  if (dispatchValue === null) return 'none';
  if (homeSet.size === 0) return 'unknown';
  return homeSet.has(dispatchValue) ? 'agree' : 'conflict';
}

/**
 * Whether a same-key candidate is this dispatch's place:
 *  - REJECT: the two name different places (town, ZIP or state) with nothing agreeing.
 *  - VERIFIED: the dispatch names a locality (in its address, or the dispatcher's locality
 *    choice), some part of it positively agrees and nothing conflicts, and neither address
 *    parsed ambiguously. A dispatch naming no locality is never verified.
 *  - UNVERIFIED: anything else. Still shown, but flagged "verify address".
 *
 * A copy is in the home area when every locality part it carries (town, ZIP, state) is in the
 * home set — including a copy that carries none. Such a copy is judged against the WHOLE home
 * set, part by part: its missing parts are the home set's, never "unknown". (Judging a
 * ZIP-only home copy by its ZIP alone would let "Bridgeport, CT 06611" verify against it while
 * the same dispatch against a town-less copy is correctly unverified.)
 */
export function judgeLocality(
  dispatch: NormalizedAddress,
  copy: NormalizedAddress,
  home: HomeLocality,
): LocalityVerdict {
  const homeKnown = home.towns.size > 0 || home.zips.size > 0;
  const homeStates: ReadonlySet<string> = new Set(home.state ? [home.state] : []);
  const inSet = (value: string | null, set: ReadonlySet<string>) =>
    value === null || set.has(value);
  const copyHome =
    homeKnown &&
    inSet(copy.town, home.towns) &&
    inSet(copy.zip, home.zips) &&
    inSet(copy.state, homeStates);

  // A town-less copy outside the home set (it carries a ZIP that is not a configured home ZIP,
  // or no home ZIPs are configured at all) has no town to compare, so a ZIP alone must not
  // verify a dispatch that names a town (round-4 m3: "12 Main St, Bridgeport, CT 06611"
  // against "12 Main St 06611"). Such a copy is never assumed home either: under a towns-only
  // home set "12 Oak St 06468" may be Monroe's (round-4b n1). Configure home ZIPs.
  const townUnknowable = !copyHome && copy.town === null;
  const town = copyHome
    ? compareHome(dispatch.town, home.towns)
    : compareValue(dispatch.town, copy.town);
  const zip = copyHome
    ? compareHome(dispatch.zip, home.zips)
    : compareValue(dispatch.zip, copy.zip);
  const state = copyHome
    ? compareHome(dispatch.state, homeStates)
    : compareValue(dispatch.state, copy.state);

  let verdict: LocalityVerdict;
  if (dispatch.town === null && dispatch.zip === null && dispatch.state === null) {
    // A dispatch that names no locality is never verified: "123 Main St" typed for a
    // mutual-aid call in another town looks exactly like a home call (round-3 R3-A).
    verdict = 'UNVERIFIED';
  } else if (state === 'conflict') {
    verdict = zip === 'agree' ? 'UNVERIFIED' : 'REJECT';
  } else if (zip === 'conflict') {
    verdict = town === 'agree' ? 'UNVERIFIED' : 'REJECT';
  } else if (town === 'conflict') {
    verdict = zip === 'agree' ? 'UNVERIFIED' : 'REJECT';
  } else if (town === 'unknown' && townUnknowable) {
    // The dispatch names a town the copy cannot confirm; its ZIP alone is not enough.
    verdict = 'UNVERIFIED';
  } else if (town === 'agree' || zip === 'agree') {
    verdict = 'VERIFIED';
  } else {
    verdict = 'UNVERIFIED';
  }
  if (verdict === 'VERIFIED' && (dispatch.ambiguous || copy.ambiguous)) {
    return 'UNVERIFIED';
  }
  return verdict;
}
