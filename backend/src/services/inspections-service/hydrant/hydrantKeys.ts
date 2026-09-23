import type { VerifiedDeptId } from '@boxalarm/dept-scope';

export type HydrantStatus = 'IN_SERVICE' | 'OUT_OF_SERVICE';

export const HYDRANT_SK = 'METADATA';

export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const HYDRANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidCalendarDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function buildHydrantDueGsi2Pk(deptId: VerifiedDeptId, yyyyMm: string): string {
  return `DEPT#${deptId}#DUE#HYDRANT#${yyyyMm}`;
}

export interface HydrantGsi2Keys {
  readonly gsi2pk: string;
  readonly gsi2sk: string;
}

export function buildHydrantGsi2Keys(
  deptId: VerifiedDeptId,
  nextFlowTestDue: string,
  hydrantId: string,
): HydrantGsi2Keys {
  if (!isValidCalendarDate(nextFlowTestDue)) {
    throw new Error(
      `nextFlowTestDue must be a valid calendar ISO date (YYYY-MM-DD), received "${nextFlowTestDue}"`,
    );
  }
  return {
    gsi2pk: buildHydrantDueGsi2Pk(deptId, nextFlowTestDue.slice(0, 7)),
    gsi2sk: `${nextFlowTestDue}#${hydrantId}`,
  };
}

// ponytail: base32-interleave geohash, no dependency for one ~30-line encoder — upgrade to
// a geohash package if a second caller needs decode/neighbor support
function encodeGeohash(latitude: number, longitude: number, precision: number): string {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let isEvenBit = true;
  let bit = 0;
  let charValue = 0;
  let geohash = '';
  while (geohash.length < precision) {
    if (isEvenBit) {
      const mid = (lonMin + lonMax) / 2;
      if (longitude >= mid) {
        charValue = (charValue << 1) | 1;
        lonMin = mid;
      } else {
        charValue = charValue << 1;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (latitude >= mid) {
        charValue = (charValue << 1) | 1;
        latMin = mid;
      } else {
        charValue = charValue << 1;
        latMax = mid;
      }
    }
    isEvenBit = !isEvenBit;
    bit += 1;
    if (bit === 5) {
      geohash += GEOHASH_BASE32[charValue];
      bit = 0;
      charValue = 0;
    }
  }
  return geohash;
}

export interface HydrantGsi3Keys {
  readonly gsi3pk: string;
  readonly gsi3sk: string;
}

export function buildHydrantGsi3Keys(
  deptId: VerifiedDeptId,
  latitude: number,
  longitude: number,
  hydrantId: string,
): HydrantGsi3Keys {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error(`latitude must be a finite number in [-90, 90], received ${latitude}`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error(`longitude must be a finite number in [-180, 180], received ${longitude}`);
  }
  const geohash8 = encodeGeohash(latitude, longitude, 8);
  return {
    gsi3pk: `DEPT#${deptId}#HYDRANT#GEO#${geohash8.slice(0, 5)}`,
    gsi3sk: `${geohash8}#${hydrantId}`,
  };
}
