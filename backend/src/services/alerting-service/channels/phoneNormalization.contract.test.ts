import { describe, expect, it } from 'vitest';
import { normalizePhoneE164 as personnelNormalize } from '../../personnel-service/lib/phone.js';
import { normalizePhoneE164 as alertingNormalize } from '../eligibility/phone.js';

/**
 * Personnel validates and stores phones in E.164; the alerting plane re-normalises what it
 * projects into SMS/VOICE contacts. The two copies must agree, or a number personnel accepts
 * would be dropped (or altered) on the way to the SMS vendor.
 */
const CASES: ReadonlyArray<readonly [string, string | undefined]> = [
  ['(270) 555-0142', '+12705550142'],
  ['270-555-0142', '+12705550142'],
  ['270.555.0142', '+12705550142'],
  ['2705550142', '+12705550142'],
  ['1-270-555-0142', '+12705550142'],
  ['+1 (270) 555-0142', '+12705550142'],
  ['+12705550142', '+12705550142'],
  ['+44 20 7946 0018', '+442079460018'],
  ['  +12035550100  ', '+12035550100'],
  ['555-0142', undefined],
  ['(070) 555-0142', undefined],
  ['(270) 155-0142', undefined],
  ['+1 070 555 0142', undefined],
  ['call me', undefined],
  ['+0 123 4567', undefined],
  ['270-555-0142 ext 5', undefined],
  ['', undefined],
];

describe('phone normalisation: personnel <-> alerting', () => {
  it.each(CASES)('%j -> %j on both planes', (raw, expected) => {
    expect(personnelNormalize(raw)).toBe(expected);
    expect(alertingNormalize(raw)).toBe(expected);
  });
});
