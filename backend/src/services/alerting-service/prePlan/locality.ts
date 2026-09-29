import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { logError } from '../dispatches/logger.js';
import { localityKey, type NormalizedAddress } from './addressKey.js';

/**
 * A department's home locality: every town, village and ZIP its own addresses are written
 * with (Nichols FD: Trumbull, Nichols, Long Hill, Trumbull Center; 06611). Occupancy
 * addresses carry no town, so a town-less pre-plan inherits this set — that is what lets a
 * mutual-aid dispatch to "123 Main St, Bridgeport" be told apart from Trumbull's 123 Main St.
 *
 * Source, in order (docs/runbooks/alert-context-replay.md, "Home locality"):
 *  1. the alerting-table item pk=DEPT#{deptId}#CONFIG, sk=HOME_LOCALITY
 *     ({ towns: string[], zips: string[], state?: string }) — editable per department;
 *  2. the ALERTING_HOME_LOCALITY env var (same JSON), set by infrastructure from the stack
 *     config `boxalarm-infra:alertingHomeLocality` (default seeded per stack deptId);
 *  3. none — then no match can be verified, and every address match is shown flagged.
 */
export interface HomeLocality {
  readonly towns: ReadonlySet<string>;
  readonly zips: ReadonlySet<string>;
  readonly state: string | null;
}

export const NO_HOME_LOCALITY: HomeLocality = { towns: new Set(), zips: new Set(), state: null };

export const HOME_LOCALITY_SK = 'HOME_LOCALITY';

export function homeLocalityKey(deptId: VerifiedDeptId) {
  return { pk: buildDeptScopedPk(deptId, 'CONFIG'), sk: HOME_LOCALITY_SK };
}

export function parseHomeLocality(raw: unknown): HomeLocality | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const strings = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  const towns = strings(value.towns)
    .map(localityKey)
    .filter((town) => town.length > 0);
  const zips = strings(value.zips).filter((zip) => /^\d{5}$/.test(zip));
  if (towns.length === 0 && zips.length === 0) return undefined;
  return {
    towns: new Set(towns),
    zips: new Set(zips),
    state: typeof value.state === 'string' ? value.state.trim().toUpperCase() || null : null,
  };
}

function fromEnv(env: NodeJS.ProcessEnv): HomeLocality | undefined {
  const raw = env.ALERTING_HOME_LOCALITY;
  if (!raw) return undefined;
  try {
    return parseHomeLocality(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Never throws: a failed read degrades to "unverifiable" (every match flagged), not to none. */
export async function loadHomeLocality(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  env: NodeJS.ProcessEnv,
): Promise<HomeLocality> {
  try {
    const { Item } = await client.send(
      new GetCommand({ TableName: tableName, Key: homeLocalityKey(deptId) }),
    );
    const configured = parseHomeLocality(Item);
    if (configured) return configured;
  } catch (error) {
    logError('preplan_copy.home_locality_read_failed', error, { deptId });
  }
  return fromEnv(env) ?? NO_HOME_LOCALITY;
}

export type LocalityVerdict = 'VERIFIED' | 'UNVERIFIED' | 'REJECT';

type Comparison = 'agree' | 'conflict' | 'unknown' | 'none';

function compare(
  dispatchValue: string | null,
  copyValue: string | null,
  copyIsHome: boolean,
  homeSet: ReadonlySet<string>,
): Comparison {
  if (dispatchValue === null) return 'none';
  if (copyValue !== null) {
    if (dispatchValue === copyValue) return 'agree';
    // Two names for the same home area (Nichols vs Trumbull) agree.
    if (homeSet.has(dispatchValue) && homeSet.has(copyValue)) return 'agree';
    return 'conflict';
  }
  if (copyIsHome && homeSet.size > 0) return homeSet.has(dispatchValue) ? 'agree' : 'conflict';
  return 'unknown';
}

/**
 * Whether a same-key candidate is this dispatch's place:
 *  - REJECT: the two name different places (town, ZIP or state) with nothing agreeing.
 *  - VERIFIED: some part of the locality positively agrees and nothing conflicts — or the
 *    dispatch names no locality and the copy's is the department's home area — and neither
 *    address parsed ambiguously.
 *  - UNVERIFIED: anything else. Still shown, but flagged "verify address".
 * A copy with no town, ZIP or state of its own is in the home locality.
 */
export function judgeLocality(
  dispatch: NormalizedAddress,
  copy: NormalizedAddress,
  home: HomeLocality,
): LocalityVerdict {
  const copyIsHome = copy.town === null && copy.zip === null && copy.state === null;
  const homeKnown = home.towns.size > 0 || home.zips.size > 0;
  const town = compare(dispatch.town, copy.town, copyIsHome, home.towns);
  const zip = compare(dispatch.zip, copy.zip, copyIsHome, home.zips);
  const homeStates = new Set(home.state ? [home.state] : []);
  const state = compare(dispatch.state, copy.state, copyIsHome, homeStates);

  let verdict: LocalityVerdict;
  if (dispatch.town === null && dispatch.zip === null && dispatch.state === null) {
    const copyInHome =
      homeKnown &&
      (copyIsHome ||
        (copy.town !== null && home.towns.has(copy.town)) ||
        (copy.zip !== null && home.zips.has(copy.zip)));
    verdict = copyInHome ? 'VERIFIED' : 'UNVERIFIED';
  } else if (state === 'conflict') {
    verdict = zip === 'agree' ? 'UNVERIFIED' : 'REJECT';
  } else if (zip === 'conflict') {
    verdict = town === 'agree' ? 'UNVERIFIED' : 'REJECT';
  } else if (town === 'conflict') {
    verdict = zip === 'agree' ? 'UNVERIFIED' : 'REJECT';
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
