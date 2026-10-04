/**
 * The alerting plane's copy of the personnel plane's phone rules (its lib/phone.ts; the two
 * planes never import each other, and channels/phoneNormalization.contract.test.ts keeps them in
 * step). Personnel stores E.164 now; this also makes a number stored before that safe, and
 * refuses what it cannot parse instead of projecting it (review MAJOR-3).
 */
const SEPARATORS = /[\s().-]/g;
const NANP = /^([2-9]\d{2})([2-9]\d{2})(\d{4})$/;

export function normalizePhoneE164(raw: string): string | undefined {
  const compact = raw.trim().replace(SEPARATORS, '');
  if (compact.startsWith('+')) {
    const digits = compact.slice(1);
    if (!/^[1-9]\d{7,14}$/.test(digits)) {
      return undefined;
    }
    if (digits.startsWith('1') && !NANP.test(digits.slice(1))) {
      return undefined;
    }
    return `+${digits}`;
  }
  if (!/^\d+$/.test(compact)) {
    return undefined;
  }
  const national = compact.length === 11 && compact.startsWith('1') ? compact.slice(1) : compact;
  return NANP.test(national) ? `+1${national}` : undefined;
}
