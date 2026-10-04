/**
 * Human labels for API enums and codes. A volunteer officer should read "Partially filled" and
 * "Turnout coat", never PARTIALLY_FILLED or turnout_coat (product review M10). Known enums get an
 * explicit word; anything else - a department-defined code - is turned into sentence case.
 */

const EXPLICIT: Readonly<Record<string, string>> = {
  // Member status (personnel types.ts MemberStatus)
  PROBATIONARY: 'Probationary',
  ACTIVE: 'Active',
  LOA: 'Leave of absence',
  RETIRED: 'Retired',
  // Certification status
  CURRENT: 'Current',
  EXPIRED: 'Expired',
  REVOKED: 'Revoked',
  // PPE status
  ISSUED: 'Issued',
  // Equipment lifecycle
  ACQUIRED: 'Acquired',
  IN_SERVICE: 'In service',
  // Shift status
  OPEN: 'Open',
  PARTIALLY_FILLED: 'Partially filled',
  FULL: 'Full',
  CANCELLED: 'Cancelled',
  // Violation status
  open: 'Open',
  resolved: 'Resolved',
};

/** "turnout_coat" -> "Turnout coat", "DRIVER_OPERATOR" -> "Driver operator". */
export function humanize(code: string): string {
  if (!code) return code;
  const explicit = EXPLICIT[code];
  if (explicit) return explicit;
  const words = code.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
