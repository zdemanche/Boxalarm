import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import { encodeGeohash } from '../map/geohash.js';

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

const HYDRANT_FLOW_TEST_INTERVAL_DAYS = 365;

export function computeHydrantNextFlowTestDue(lastFlowTestDate: string): string {
  const next = new Date(`${lastFlowTestDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + HYDRANT_FLOW_TEST_INTERVAL_DAYS);
  return next.toISOString().slice(0, 10);
}

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
