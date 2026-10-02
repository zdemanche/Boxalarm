/**
 * Default home locality per stack deptId (prePlan/locality.ts in the backend): the towns,
 * villages and ZIPs a department's own addresses are written with. A town-less pre-plan
 * inherits it, and only a dispatch inside it (or naming no town) can match a pre-plan as a
 * verified — unflagged — ADDRESS. Override with `boxalarm-infra:alertingHomeLocality` (JSON),
 * or per department at runtime with the alerting-table item DEPT#{deptId}#CONFIG /
 * HOME_LOCALITY (docs/runbooks/alert-context-replay.md, "Home locality").
 *
 * The set must be ONE street-numbering area: a single town and its villages/sections. Any two
 * home names are treated as the same place, so listing two towns would let "12 Main St,
 * Monroe" verify against Trumbull's 12 Main St. The backend logs
 * preplan_copy.home_locality_multi_town when a set names more than one CT town.
 */
export interface HomeLocalityConfig {
  towns: string[];
  zips: string[];
  state?: string;
}

export const DEFAULT_HOME_LOCALITY: Readonly<Record<string, HomeLocalityConfig>> = {
  // Tenant zero: Nichols FD, Trumbull CT (villages Nichols, Long Hill, Trumbull Center).
  "nichols-fd": {
    towns: ["Trumbull", "Nichols", "Long Hill", "Trumbull Center"],
    zips: ["06611"],
    state: "CT",
  },
};

/**
 * The JSON for ALERTING_HOME_LOCALITY: the explicit stack config if set (validated), else the
 * default for this deptId, else undefined — then no address match is ever verified and every
 * one is shown "verify address" (safe, but noisy: set it).
 */
export function resolveHomeLocality(
  deptId: string,
  configured: string | undefined,
): string | undefined {
  // The JSON carries the deptId it is for: the backend applies it to that department only.
  if (configured !== undefined) {
    const parsed = JSON.parse(configured) as Partial<HomeLocalityConfig>;
    if (!Array.isArray(parsed.towns) && !Array.isArray(parsed.zips)) {
      throw new Error(
        "boxalarm-infra:alertingHomeLocality must be JSON with a towns and/or zips array",
      );
    }
    return JSON.stringify({ ...parsed, deptId });
  }
  const fallback = DEFAULT_HOME_LOCALITY[deptId];
  return fallback ? JSON.stringify({ ...fallback, deptId }) : undefined;
}

/**
 * Whether a resolved home locality lists towns but no ZIPs. It still works, but a pre-plan whose
 * address carries only a ZIP is then never verified (round-4b n1): recommend configuring ZIPs.
 */
export function homeLocalityLacksZips(resolved: string | undefined): boolean {
  if (resolved === undefined) return false;
  const parsed = JSON.parse(resolved) as Partial<HomeLocalityConfig>;
  return !Array.isArray(parsed.zips) || parsed.zips.length === 0;
}
